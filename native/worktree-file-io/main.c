#define _DARWIN_C_SOURCE 1

#include <CommonCrypto/CommonDigest.h>
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define MAX_RELATIVE_PATH 512
#define MAX_FILE_BYTES (256U * 1024U * 1024U)
#define MAX_EDITOR_BYTES 1500000U
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
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  char *copy = strdup(path + 1);
  if (copy == NULL) { close(fd); return -1; }
  char *part = copy;
  while (*part != '\0') {
    char *slash = strchr(part, '/');
    if (slash != NULL) *slash = '\0';
    if (*part == '\0' || strcmp(part, ".") == 0 || strcmp(part, "..") == 0) {
      free(copy); close(fd); return -1;
    }
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(fd);
    if (next < 0) { free(copy); return -1; }
    fd = next;
    if (slash == NULL) break;
    part = slash + 1;
  }
  free(copy);
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

static int valid_editor_relative(const char *value) {
  size_t length = strlen(value);
  if (length == 0 || length > 4096 || value[0] == '/' || value[length - 1] == '/') return 0;
  const char *part = value;
  for (const char *cursor = value;; cursor++) {
    if (*cursor == '\\') return 0;
    if (*cursor == '/' || *cursor == '\0') {
      size_t size = (size_t)(cursor - part);
      if (size == 0 || size > 255 || (size == 1 && part[0] == '.') ||
          (size == 2 && part[0] == '.' && part[1] == '.')) return 0;
      if (*cursor == '\0') break;
      part = cursor + 1;
    }
  }
  return 1;
}

static int editor_parent_at(int root, const char *relative, char leaf[256]) {
  char *parts = strdup(relative);
  if (parts == NULL) return -1;
  int current = openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) { free(parts); return -1; }
  char *part = parts;
  for (;;) {
    char *slash = strchr(part, '/');
    if (slash == NULL) { memcpy(leaf, part, strlen(part) + 1); free(parts); return current; }
    *slash = '\0';
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current);
    if (next < 0) { free(parts); return -1; }
    current = next;
    part = slash + 1;
  }
}

/* App-created recovery copies are retained. Serialize our editors on the held
 * parent inode, then refuse a new save before staging if retention is full or
 * a bounded scan cannot establish that room remains. */
static int recovery_room(int parent) {
  int descriptor = openat(parent, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return 0;
  DIR *directory = fdopendir(descriptor);
  if (directory == NULL) { close(descriptor); return 0; }
  size_t scanned = 0, retained = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      int good = errno == 0;
      closedir(directory);
      return good;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (++scanned > 8000) { closedir(directory); return 0; }
    if (strncmp(entry->d_name, ".aiden-recovery-", 16) == 0 && ++retained >= 16) {
      closedir(directory);
      return 0;
    }
  }
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

static int exclusive_regular(const struct stat *metadata) {
  return S_ISREG(metadata->st_mode) && metadata->st_nlink == 1;
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

static int skip_directory(const char *name) {
  const char *skipped[] = { ".git", ".cache", ".build", ".next", ".turbo",
    "build", "coverage", "dist", "node_modules", "release" };
  for (size_t i = 0; i < sizeof(skipped) / sizeof(skipped[0]); i++) {
    if (strcmp(name, skipped[i]) == 0) return 1;
  }
  return 0;
}

/* Read-only, descriptor-relative enumeration. No pathname is reopened after
 * the root/each component is held, including while readdir advances. */
static int list_directory(int argc, char **argv) {
  uint64_t root_device, root_inode, directory_device, directory_inode;
  if (argc != 8 || strlen(argv[5]) > 4096 ||
      !decimal(argv[3], &root_device) || !decimal(argv[4], &root_inode) ||
      !decimal(argv[6], &directory_device) || !decimal(argv[7], &directory_inode)) return fail("invalid_input");
  int current = open_root(argv[2], root_device, root_inode);
  if (current < 0) return fail("unsafe_source");
  char *parts = strdup(argv[5]);
  if (parts == NULL) { close(current); return fail("io_failed"); }
  char *part = parts;
  while (*part != '\0') {
    char *slash = strchr(part, '/');
    if (slash != NULL) *slash = '\0';
    if (*part == '\0' || strcmp(part, ".") == 0 || strcmp(part, "..") == 0 ||
        strchr(part, '\\') != NULL || (slash != NULL && slash[1] == '\0')) {
      free(parts); close(current); return fail("invalid_input");
    }
    int next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current);
    if (next < 0) { free(parts); return fail("unsafe_source"); }
    current = next;
    if (slash == NULL) break;
    part = slash + 1;
  }
  free(parts);
  struct stat metadata;
  if (fstat(current, &metadata) != 0 || !S_ISDIR(metadata.st_mode) ||
      (uint64_t)metadata.st_dev != directory_device || (uint64_t)metadata.st_ino != directory_inode) {
    close(current); return fail("source_changed");
  }
  if (test_checkpoint('L') != 0) { close(current); return fail("io_failed"); }
  DIR *directory = fdopendir(current);
  if (directory == NULL) { close(current); return fail("io_failed"); }
  size_t scanned = 0, emitted = 0;
  int truncated = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      if (errno != 0) { closedir(directory); return fail("io_failed"); }
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (++scanned > 8000 || emitted >= 4000) { truncated = 1; break; }
    struct stat child;
    if (fstatat(current, entry->d_name, &child, AT_SYMLINK_NOFOLLOW) != 0) { truncated = 1; continue; }
    if (!S_ISDIR(child.st_mode) && !exclusive_regular(&child)) continue;
    if (S_ISDIR(child.st_mode) && skip_directory(entry->d_name)) continue;
    size_t length = strlen(entry->d_name);
    if (length == 0 || length > 255) { truncated = 1; continue; }
    fprintf(stdout, "%c %" PRIu64 " %" PRIu64 " ",
            S_ISDIR(child.st_mode) ? 'd' : 'f',
            (uint64_t)child.st_dev, (uint64_t)child.st_ino);
    for (size_t i = 0; i < length; i++) fprintf(stdout, "%02x", (unsigned char)entry->d_name[i]);
    fputc('\n', stdout);
    emitted++;
  }
  closedir(directory);
  if (test_checkpoint('E') != 0) return fail("io_failed");
  fprintf(stdout, "%c\n", truncated ? 't' : 'c');
  return ferror(stdout) ? fail("io_failed") : 0;
}

static int editor_file(int argc, char **argv, int edit) {
  uint64_t root_device, root_inode, file_device, file_inode, input_length = 0;
  if (argc != (edit ? 10 : 8) || !valid_editor_relative(argv[5]) ||
      !decimal(argv[3], &root_device) || !decimal(argv[4], &root_inode) ||
      !decimal(argv[6], &file_device) || !decimal(argv[7], &file_inode) ||
      (edit && (!valid_digest(argv[8]) || !decimal(argv[9], &input_length) ||
                input_length > MAX_EDITOR_BYTES))) return fail("invalid_input");
  unsigned char *input = NULL;
  if (edit) {
    input = malloc(input_length == 0 ? 1 : (size_t)input_length);
    if (input == NULL) return fail("io_failed");
    size_t received = 0;
    while (received < input_length) {
      ssize_t count = read(STDIN_FILENO, input + received, (size_t)input_length - received);
      if (count < 0 && errno == EINTR) continue;
      if (count <= 0) { free(input); return fail("invalid_input"); }
      received += (size_t)count;
    }
  }
  int root = open_root(argv[2], root_device, root_inode);
  if (root < 0) { free(input); return fail("unsafe_source"); }
  char leaf[256];
  int parent = editor_parent_at(root, argv[5], leaf);
  close(root);
  if (parent < 0) { free(input); return fail("unsafe_source"); }
  if (test_checkpoint(edit ? 'E' : 'R') != 0) {
    free(input); close(parent); return fail("io_failed");
  }
  int source = openat(parent, leaf, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  struct stat before, after;
  if (source < 0 || fstat(source, &before) != 0 || !exclusive_regular(&before) ||
      before.st_size < 0 || (uint64_t)before.st_dev != file_device ||
      (uint64_t)before.st_ino != file_inode) {
    if (source >= 0) close(source);
    free(input); close(parent); return fail("source_changed");
  }
  if ((uint64_t)before.st_size > MAX_EDITOR_BYTES) {
    close(source); free(input); close(parent); return fail("too_many_bytes");
  }
  unsigned char *content = malloc(before.st_size == 0 ? 1 : (size_t)before.st_size);
  if (content == NULL) { close(source); free(input); close(parent); return fail("io_failed"); }
  size_t total = 0;
  while (total < (size_t)before.st_size) {
    ssize_t count = pread(source, content + total, (size_t)before.st_size - total, (off_t)total);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { free(content); close(source); free(input); close(parent); return fail("source_changed"); }
    total += (size_t)count;
  }
  if (test_checkpoint('B') != 0 || fstat(source, &after) != 0 ||
      !exclusive_regular(&after) || !same_source(&before, &after)) {
    free(content); close(source); free(input); close(parent); return fail("source_changed");
  }
  unsigned char digest_bytes[CC_SHA256_DIGEST_LENGTH];
  char old_hash[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  CC_SHA256(content, (CC_LONG)total, digest_bytes);
  digest_hex(digest_bytes, old_hash);
  if (!edit) {
    printf("r %zu %u %lld %ld %s\n", total,
           (unsigned)(before.st_mode & 07777), (long long)before.st_mtimespec.tv_sec,
           before.st_mtimespec.tv_nsec, old_hash);
    if (total > 0 && fwrite(content, 1, total, stdout) != total) {
      free(content); close(source); close(parent); return fail("io_failed");
    }
    int good = !ferror(stdout);
    free(content); close(source); close(parent);
    return good ? 0 : fail("io_failed");
  }
  free(content);
  if (strcmp(old_hash, argv[8]) != 0) {
    close(source); free(input); close(parent); return fail("source_changed");
  }
  if (flock(parent, LOCK_EX) != 0 || !recovery_room(parent)) {
    close(source); free(input); close(parent); return fail("recovery_limit");
  }
  char new_hash[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  CC_SHA256(input, (CC_LONG)input_length, digest_bytes);
  digest_hex(digest_bytes, new_hash);
  unsigned char nonce[16];
  arc4random_buf(nonce, sizeof(nonce));
  char suffix[sizeof(nonce) * 2 + 1];
  for (size_t i = 0; i < sizeof(nonce); i++) snprintf(suffix + i * 2, 3, "%02x", nonce[i]);
  char temporary[64], recovery[64];
  snprintf(temporary, sizeof(temporary), ".aiden-%s.tmp", suffix);
  snprintf(recovery, sizeof(recovery), ".aiden-recovery-%s", suffix);
  int target = openat(parent, temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (target < 0) { close(source); free(input); close(parent); return fail("io_failed"); }
  size_t written = 0;
  int good = 1;
  while (written < input_length) {
    ssize_t count = write(target, input + written, (size_t)input_length - written);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { good = 0; break; }
    written += (size_t)count;
  }
  free(input);
  if (good && (fchmod(target, before.st_mode & 07777) != 0 || fsync(target) != 0)) good = 0;
  struct stat current;
  if (good && test_checkpoint('D') != 0) good = 0;
  if (good && (fstat(source, &after) != 0 || !exclusive_regular(&after) || !same_source(&before, &after) ||
      fstatat(parent, leaf, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !exclusive_regular(&current) || !same_source(&before, &current))) good = 0;
  if (!good) {
    close(target); (void)unlinkat(parent, temporary, 0);
    close(source); close(parent); return fail("source_changed");
  }
  if (renameatx_np(parent, leaf, parent, recovery, RENAME_EXCL) != 0) {
    close(target); (void)unlinkat(parent, temporary, 0);
    close(source); close(parent); return fail("destination_exists");
  }
  struct stat displaced;
  int moved = openat(parent, recovery, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  char moved_hash[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  good = moved >= 0 && fstat(moved, &displaced) == 0 && exclusive_regular(&displaced) && same_source(&before, &displaced) &&
      file_digest(moved, (uint64_t)before.st_size, moved_hash) && strcmp(moved_hash, old_hash) == 0 &&
      fstat(moved, &displaced) == 0 && exclusive_regular(&displaced) && same_source(&before, &displaced);
  if (moved >= 0) close(moved);
  if (!good) {
    (void)linkat(parent, recovery, parent, leaf, 0);
    close(target); (void)unlinkat(parent, temporary, 0);
    close(source); close(parent); return fail("source_changed");
  }
  if (linkat(parent, temporary, parent, leaf, 0) != 0) {
    (void)linkat(parent, recovery, parent, leaf, 0);
    close(target); (void)unlinkat(parent, temporary, 0);
    close(source); close(parent); return fail("destination_exists");
  }
  struct stat saved;
  struct stat installed;
  char installed_hash[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  good = fstat(target, &saved) == 0 &&
      S_ISREG(saved.st_mode) && saved.st_nlink == 2 && saved.st_size == (off_t)input_length &&
      file_digest(target, input_length, installed_hash) &&
      strcmp(installed_hash, new_hash) == 0 &&
      fstatat(parent, leaf, &installed, AT_SYMLINK_NOFOLLOW) == 0 &&
      saved.st_dev == installed.st_dev && saved.st_ino == installed.st_ino &&
      fsync(parent) == 0;
  if (good) good = unlinkat(parent, temporary, 0) == 0 &&
      fstat(target, &saved) == 0 && exclusive_regular(&saved);
  close(target); close(source); close(parent);
  if (!good) return fail("io_failed");
  /* Report the installed descriptor's identity and the staged content hash. */
  printf("w %" PRIu64 " %" PRIu64 " %u %lld %ld %s ",
         (uint64_t)saved.st_dev, (uint64_t)saved.st_ino,
         (unsigned)(saved.st_mode & 07777), (long long)saved.st_mtimespec.tv_sec,
         saved.st_mtimespec.tv_nsec, new_hash);
  for (const unsigned char *cursor = (const unsigned char *)recovery; *cursor != '\0'; cursor++)
    printf("%02x", *cursor);
  fputc('\n', stdout);
  return ferror(stdout) ? fail("io_failed") : 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "list") == 0) return list_directory(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "read") == 0) return editor_file(argc, argv, 0);
  if (argc >= 2 && strcmp(argv[1], "edit") == 0) return editor_file(argc, argv, 1);
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
