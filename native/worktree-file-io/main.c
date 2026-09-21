#define _DARWIN_C_SOURCE 1

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define MAX_RELATIVE_PATH 512
#define MAX_FILE_BYTES (256U * 1024U * 1024U)
#define BUFFER_BYTES (64U * 1024U)
#define INFLIGHT_SUFFIX ".aiden-restore-inflight"

static int fail(const char *reason) {
  fprintf(stderr, "%s\n", reason);
  return 1;
}

static int decimal(const char *value, uint64_t *result) {
  if (value == NULL || *value == '\0') return 0;
  char *end = NULL;
  errno = 0;
  uintmax_t number = strtoumax(value, &end, 10);
  if (errno != 0 || *end != '\0' || number > UINT64_MAX) return 0;
  *result = (uint64_t)number;
  return 1;
}

static int valid_relative(const char *value) {
  size_t length = strlen(value);
  if (length == 0 || length > MAX_RELATIVE_PATH || value[0] == '/' ||
      value[length - 1] == '/') return 0;
  const char *part = value;
  for (const char *cursor = value;; cursor++) {
    if (*cursor == '\\') return 0;
    if (*cursor == '/' || *cursor == '\0') {
      size_t size = (size_t)(cursor - part);
      if (size == 0 || (size == 1 && part[0] == '.') ||
          (size == 2 && part[0] == '.' && part[1] == '.')) return 0;
      if (*cursor == '\0') break;
      part = cursor + 1;
    }
  }
  return 1;
}

static int open_root(const char *path, uint64_t device, uint64_t inode) {
  if (path[0] != '/') return -1;
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat metadata;
  if (fstat(fd, &metadata) != 0 || !S_ISDIR(metadata.st_mode) ||
      (uint64_t)metadata.st_dev != device ||
      (uint64_t)metadata.st_ino != inode) {
    close(fd);
    errno = EPERM;
    return -1;
  }
  return fd;
}

/* Every component is opened beneath the preceding descriptor. A renamed or
 * replaced ancestor cannot redirect an already opened descriptor. */
static int parent_at(int root, const char *relative, int create,
                     char leaf[MAX_RELATIVE_PATH + 1]) {
  char parts[MAX_RELATIVE_PATH + 1];
  memcpy(parts, relative, strlen(relative) + 1);
  int current = openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) return -1;
  char *part = parts;
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash == NULL) {
      memcpy(leaf, part, strlen(part) + 1);
      return current;
    }
    *slash = '\0';
    if (create && mkdirat(current, part, 0755) != 0 && errno != EEXIST) {
      close(current);
      return -1;
    }
    int next = openat(current, part,
                      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current);
    if (next < 0) return -1;
    current = next;
    part = slash + 1;
  }
}

static int same_source(const struct stat *before, const struct stat *after) {
  return before->st_dev == after->st_dev &&
         before->st_ino == after->st_ino &&
         before->st_size == after->st_size &&
         before->st_mtimespec.tv_sec == after->st_mtimespec.tv_sec &&
         before->st_mtimespec.tv_nsec == after->st_mtimespec.tv_nsec;
}

static void digest_hex(const unsigned char bytes[CC_SHA256_DIGEST_LENGTH],
                       char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1]) {
  static const char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    hex[index * 2] = digits[bytes[index] >> 4];
    hex[index * 2 + 1] = digits[bytes[index] & 15];
  }
  hex[CC_SHA256_DIGEST_LENGTH * 2] = '\0';
}

static int valid_digest(const char *value) {
  if (strlen(value) != CC_SHA256_DIGEST_LENGTH * 2) return 0;
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH * 2; index++) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int test_checkpoint(char marker) {
#ifdef AIDEN_WORKTREE_FILE_IO_TESTING
  if (getenv("AIDEN_WORKTREE_FILE_IO_HANDSHAKE") == NULL) return 0;
  if (write(3, &marker, 1) != 1) return -1;
  char reply;
  ssize_t count;
  do { count = read(4, &reply, 1); } while (count < 0 && errno == EINTR);
  return count == 1 && reply == marker ? 0 : -1;
#else
  (void)marker;
  return 0;
#endif
}

static int identical_files(int source, int destination, uint64_t length) {
  unsigned char left[BUFFER_BYTES], right[BUFFER_BYTES];
  uint64_t offset = 0;
  while (offset < length) {
    size_t amount = length - offset < BUFFER_BYTES ? (size_t)(length - offset) : BUFFER_BYTES;
    ssize_t a, b;
    do { a = pread(source, left, amount, (off_t)offset); } while (a < 0 && errno == EINTR);
    do { b = pread(destination, right, amount, (off_t)offset); } while (b < 0 && errno == EINTR);
    if (a != (ssize_t)amount || b != (ssize_t)amount || memcmp(left, right, amount) != 0)
      return 0;
    offset += amount;
  }
  return 1;
}

static int file_digest(int descriptor, uint64_t length,
                       char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1]) {
  CC_SHA256_CTX digest;
  CC_SHA256_Init(&digest);
  unsigned char buffer[BUFFER_BYTES];
  uint64_t offset = 0;
  while (offset < length) {
    size_t amount = length - offset < BUFFER_BYTES ? (size_t)(length - offset) : BUFFER_BYTES;
    ssize_t count;
    do { count = pread(descriptor, buffer, amount, (off_t)offset); }
    while (count < 0 && errno == EINTR);
    if (count != (ssize_t)amount) return 0;
    CC_SHA256_Update(&digest, buffer, (CC_LONG)count);
    offset += amount;
  }
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(bytes, &digest);
  digest_hex(bytes, hex);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 13 ||
      (strcmp(argv[1], "copy") != 0 && strcmp(argv[1], "restore") != 0) ||
      !valid_relative(argv[5]) || !valid_relative(argv[9])) return fail("invalid_input");
  const int restore = strcmp(argv[1], "restore") == 0;
  uint64_t source_device, source_inode, target_device, target_inode, limit;
  if (!decimal(argv[3], &source_device) || !decimal(argv[4], &source_inode) ||
      !decimal(argv[7], &target_device) || !decimal(argv[8], &target_inode) ||
      !decimal(argv[10], &limit) || limit > MAX_FILE_BYTES ||
      (restore && !valid_digest(argv[11])) ||
      (!restore && strcmp(argv[11], "-") != 0)) return fail("invalid_input");
  uint64_t mode_value = 0;
  if (strcmp(argv[12], "source") != 0 &&
      (!decimal(argv[12], &mode_value) || mode_value > 0777U)) return fail("invalid_input");
  if (restore && strcmp(argv[12], "source") == 0) return fail("invalid_input");

  int source_root = open_root(argv[2], source_device, source_inode);
  if (source_root < 0) return fail("unsafe_source");
  char source_leaf[MAX_RELATIVE_PATH + 1];
  int source_parent = parent_at(source_root, argv[5], 0, source_leaf);
  close(source_root);
  if (source_parent < 0) return fail("unsafe_source");
  if (test_checkpoint('S') != 0) { close(source_parent); return fail("io_failed"); }
  int source = openat(source_parent, source_leaf,
                      O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  close(source_parent);
  struct stat before, after;
  if (source < 0 || fstat(source, &before) != 0 || !S_ISREG(before.st_mode) ||
      before.st_size < 0) {
    if (source >= 0) close(source);
    return fail("unsafe_source");
  }
  if ((uint64_t)before.st_size > limit) {
    close(source);
    return fail(restore ? "blob_corrupt" : "too_many_bytes");
  }
  if (restore && (uint64_t)before.st_size != limit) {
    close(source);
    return fail("blob_corrupt");
  }

  int target_root = open_root(argv[6], target_device, target_inode);
  if (target_root < 0) { close(source); return fail("unsafe_destination"); }
  char target_leaf[MAX_RELATIVE_PATH + 1];
  int target_parent = parent_at(target_root, argv[9], 1, target_leaf);
  close(target_root);
  if (target_parent < 0) { close(source); return fail("unsafe_destination"); }
  if (test_checkpoint('D') != 0) {
    close(source); close(target_parent); return fail("io_failed");
  }

  char inflight[MAX_RELATIVE_PATH + sizeof(INFLIGHT_SUFFIX) + 1];
  const char *write_name = target_leaf;
  if (restore) {
    snprintf(inflight, sizeof(inflight), "%s%s", target_leaf, INFLIGHT_SUFFIX);
    struct stat stale;
    if (fstatat(target_parent, inflight, &stale, AT_SYMLINK_NOFOLLOW) == 0 &&
        (S_ISDIR(stale.st_mode) || unlinkat(target_parent, inflight, 0) != 0)) {
      close(source); close(target_parent); return fail("unsafe_destination");
    }
    int existing = openat(target_parent, target_leaf,
                          O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (existing >= 0) {
      struct stat current;
      char source_digest[CC_SHA256_DIGEST_LENGTH * 2 + 1];
      int identical = fstat(existing, &current) == 0 && S_ISREG(current.st_mode) &&
          current.st_size == before.st_size &&
          file_digest(source, (uint64_t)before.st_size, source_digest) &&
          strcmp(source_digest, argv[11]) == 0 &&
          fstat(source, &after) == 0 && same_source(&before, &after) &&
          identical_files(source, existing, (uint64_t)before.st_size);
      if (identical && fchmod(existing, (mode_t)mode_value) != 0) identical = 0;
      close(existing); close(source); close(target_parent);
      return identical ? 0 : fail("destination_exists");
    }
    if (errno != ENOENT) { close(source); close(target_parent); return fail("destination_exists"); }
    write_name = inflight;
  }

  mode_t mode = strcmp(argv[12], "source") == 0
      ? (before.st_mode & 0777) : (mode_t)mode_value;
  int target = openat(target_parent, write_name,
                      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (target < 0) {
    close(source); close(target_parent);
    return fail(errno == EEXIST ? "destination_exists" : "unsafe_destination");
  }
  CC_SHA256_CTX digest;
  CC_SHA256_Init(&digest);
  unsigned char buffer[BUFFER_BYTES];
  uint64_t copied = 0;
  int good = 1;
  while (copied < (uint64_t)before.st_size) {
    size_t amount = (uint64_t)before.st_size - copied < BUFFER_BYTES
        ? (size_t)((uint64_t)before.st_size - copied) : BUFFER_BYTES;
    ssize_t received = read(source, buffer, amount);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) { good = 0; break; }
    CC_SHA256_Update(&digest, buffer, (CC_LONG)received);
    size_t written = 0;
    while (written < (size_t)received) {
      ssize_t count = write(target, buffer + written, (size_t)received - written);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) { good = 0; break; }
      written += (size_t)count;
    }
    if (!good) break;
    copied += (uint64_t)received;
  }
  unsigned char digest_bytes[CC_SHA256_DIGEST_LENGTH];
  char hex[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  CC_SHA256_Final(digest_bytes, &digest);
  digest_hex(digest_bytes, hex);
  if (fstat(source, &after) != 0 || !same_source(&before, &after) ||
      copied != (uint64_t)before.st_size) good = 0;
  if (restore && strcmp(hex, argv[11]) != 0) good = 0;
  if (good && (fchmod(target, mode) != 0 || fsync(target) != 0)) good = 0;
  close(target);
  close(source);
  if (!good) {
    (void)unlinkat(target_parent, write_name, 0);
    close(target_parent);
    return fail(restore ? "blob_corrupt" : "source_changed");
  }
  if (restore) {
    if (renameatx_np(target_parent, write_name, target_parent, target_leaf,
                     RENAME_EXCL) != 0) {
      (void)unlinkat(target_parent, write_name, 0);
      close(target_parent);
      return fail("destination_exists");
    }
  }
  if (fsync(target_parent) != 0) {
    if (!restore) (void)unlinkat(target_parent, target_leaf, 0);
    close(target_parent);
    return fail("io_failed");
  }
  close(target_parent);
  printf("%" PRIu64 " %u %u %s\n", copied, (unsigned)mode,
         (unsigned)(before.st_mode & 0777), hex);
  return 0;
}
