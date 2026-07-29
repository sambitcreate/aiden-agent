#include <CommonCrypto/CommonDigest.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define EXIT_IDENTITY_CHANGED 20
#define EXIT_MUTATION_DETECTED 21
#define EXIT_IO_FAILED 22
#define EXIT_AUTHORIZATION_ABORTED 23
#define EXIT_INVALID_INPUT 64
#define MAX_ENTRIES 200000
#define MAX_DEPTH 128
#define QUARANTINE_PREFIX ".aiden-removing-"
#define AUTHORIZATION_PREFIX ".aiden-authorizing-"
#define MANIFEST_PREFIX ".aiden-removal-manifest-"
#define MANIFEST_FINALIZING_SUFFIX ".finalizing"
#define MANIFEST_DELETING_SUFFIX ".deleting"
#define ISOLATION_PREFIX ".aiden-isolated-"
#define CAPTURE_PREFIX ".aiden-capture-"
#define MANIFEST_MAGIC "AIDEN-WORKTREE-MANIFEST-1\n"
#define MANIFEST_MAGIC_LENGTH 26
#define SHA256_HEX_LENGTH 64
#define MAX_CAPTURE_ATTEMPTS 32

typedef struct EntryList EntryList;

typedef struct {
  char name[NAME_MAX + 1];
  struct stat identity;
  EntryList *children;
} Entry;

struct EntryList {
  Entry *items;
  size_t count;
};

typedef int (*IdentityMatcher)(const struct stat *, const struct stat *);

static size_t total_entries = 0;

static int test_pause(const char *environment_name);
static int delete_validated_entry(int directory_fd, const char *source_name,
                                  const struct stat *expected,
                                  IdentityMatcher identity_matches,
                                  const char *pause_environment,
                                  int unlink_flags);

static int write_all(int descriptor, const void *buffer, size_t length) {
  const unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t count = write(descriptor, cursor, length);
    if (count > 0) {
      cursor += count;
      length -= (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR)
      continue;
    return 0;
  }
  return 1;
}

static int read_all(int descriptor, void *buffer, size_t length) {
  unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t count = read(descriptor, cursor, length);
    if (count > 0) {
      cursor += count;
      length -= (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR)
      continue;
    return 0;
  }
  return 1;
}

static int write_uint64(int descriptor, uint64_t value) {
  unsigned char encoded[8];
  for (size_t index = 0; index < sizeof(encoded); index += 1) {
    encoded[sizeof(encoded) - 1 - index] =
        (unsigned char)(value & UINT64_C(0xff));
    value >>= 8;
  }
  return write_all(descriptor, encoded, sizeof(encoded));
}

static int read_uint64(int descriptor, uint64_t *value) {
  unsigned char encoded[8];
  if (!read_all(descriptor, encoded, sizeof(encoded)))
    return 0;
  uint64_t decoded = 0;
  for (size_t index = 0; index < sizeof(encoded); index += 1)
    decoded = (decoded << 8) | encoded[index];
  *value = decoded;
  return 1;
}

static int same_timestamp(const struct timespec left,
                          const struct timespec right) {
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

static int same_entry_identity(const struct stat *left,
                               const struct stat *right) {
#ifdef __APPLE__
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT) &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtimespec, right->st_mtimespec) &&
         same_timestamp(left->st_ctimespec, right->st_ctimespec);
#else
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT) &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtim, right->st_mtim) &&
         same_timestamp(left->st_ctim, right->st_ctim);
#endif
}

static int same_directory_identity(const struct stat *left,
                                   const struct stat *right) {
  return S_ISDIR(left->st_mode) && S_ISDIR(right->st_mode) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode;
}

static int same_object_identity(const struct stat *left,
                                const struct stat *right) {
#ifdef __APPLE__
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_size == right->st_size &&
         same_timestamp(left->st_mtimespec, right->st_mtimespec);
#else
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_size == right->st_size &&
         same_timestamp(left->st_mtim, right->st_mtim);
#endif
}

static void free_entries(EntryList *entries) {
  for (size_t index = 0; index < entries->count; index += 1) {
    if (entries->items[index].children != NULL) {
      free_entries(entries->items[index].children);
      free(entries->items[index].children);
    }
  }
  free(entries->items);
  entries->items = NULL;
  entries->count = 0;
}

static int compare_entries(const void *left_value, const void *right_value) {
  const Entry *left = left_value;
  const Entry *right = right_value;
  return strcmp(left->name, right->name);
}

static int read_entries(int directory_fd, dev_t root_device,
                        EntryList *result) {
  int duplicate = openat(directory_fd, ".",
                         O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (duplicate < 0)
    return EXIT_IO_FAILED;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    close(duplicate);
    return EXIT_IO_FAILED;
  }

  Entry *items = NULL;
  size_t count = 0;
  size_t capacity = 0;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
      continue;
    if (strnlen(entry->d_name, NAME_MAX + 1) > NAME_MAX ||
        ++total_entries > MAX_ENTRIES) {
      free(items);
      closedir(directory);
      return EXIT_MUTATION_DETECTED;
    }
    if (count == capacity) {
      size_t next_capacity = capacity == 0 ? 32 : capacity * 2;
      Entry *next = realloc(items, next_capacity * sizeof(*items));
      if (next == NULL) {
        free(items);
        closedir(directory);
        return EXIT_IO_FAILED;
      }
      items = next;
      capacity = next_capacity;
    }
    memset(&items[count], 0, sizeof(items[count]));
    memcpy(items[count].name, entry->d_name, strlen(entry->d_name));
    if (fstatat(directory_fd, entry->d_name, &items[count].identity,
                AT_SYMLINK_NOFOLLOW) != 0) {
      free(items);
      closedir(directory);
      return errno == ENOENT ? EXIT_MUTATION_DETECTED : EXIT_IO_FAILED;
    }
    if (items[count].identity.st_dev != root_device ||
        (!S_ISDIR(items[count].identity.st_mode) &&
         !S_ISREG(items[count].identity.st_mode) &&
         !S_ISLNK(items[count].identity.st_mode))) {
      free(items);
      closedir(directory);
      return EXIT_MUTATION_DETECTED;
    }
    count += 1;
  }
  int read_error = errno;
  if (closedir(directory) != 0 || read_error != 0) {
    free(items);
    return EXIT_IO_FAILED;
  }
  qsort(items, count, sizeof(*items), compare_entries);
  result->items = items;
  result->count = count;
  return 0;
}

static int stable_entries(int directory_fd, dev_t root_device,
                          EntryList *result) {
  EntryList first = {0};
  EntryList second = {0};
  int code = read_entries(directory_fd, root_device, &first);
  if (code != 0)
    return code;
  code = read_entries(directory_fd, root_device, &second);
  if (code != 0) {
    free_entries(&first);
    return code;
  }
  if (first.count != second.count) {
    free_entries(&first);
    free_entries(&second);
    return EXIT_MUTATION_DETECTED;
  }
  for (size_t index = 0; index < first.count; index += 1) {
    if (strcmp(first.items[index].name, second.items[index].name) != 0 ||
        !same_entry_identity(&first.items[index].identity,
                             &second.items[index].identity)) {
      free_entries(&first);
      free_entries(&second);
      return EXIT_MUTATION_DETECTED;
    }
  }
  free_entries(&second);
  *result = first;
  return 0;
}

static int same_entries(const EntryList *left, const EntryList *right) {
  if (left->count != right->count)
    return 0;
  for (size_t index = 0; index < left->count; index += 1) {
    if (strcmp(left->items[index].name, right->items[index].name) != 0 ||
        !same_entry_identity(&left->items[index].identity,
                             &right->items[index].identity)) {
      return 0;
    }
  }
  return 1;
}

/*
 * Capture the complete directory tree before asking the parent process to
 * authorize deletion. Removal consumes only this manifest, so a late entry can
 * never become eligible merely because a recursive scan reaches it later.
 */
static int snapshot_tree(int directory_fd, dev_t root_device, int depth,
                         EntryList *result) {
  if (depth > MAX_DEPTH)
    return EXIT_MUTATION_DETECTED;
  EntryList entries = {0};
  int code = stable_entries(directory_fd, root_device, &entries);
  if (code != 0)
    return code;

  for (size_t index = 0; index < entries.count; index += 1) {
    Entry *entry = &entries.items[index];
    if (!S_ISDIR(entry->identity.st_mode))
      continue;
    int child_fd = openat(directory_fd, entry->name,
                          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (child_fd < 0) {
      free_entries(&entries);
      return errno == ELOOP || errno == ENOENT ? EXIT_MUTATION_DETECTED
                                               : EXIT_IO_FAILED;
    }
    struct stat child_identity;
    if (fstat(child_fd, &child_identity) != 0 ||
        !same_entry_identity(&entry->identity, &child_identity)) {
      close(child_fd);
      free_entries(&entries);
      return EXIT_MUTATION_DETECTED;
    }
    entry->children = calloc(1, sizeof(*entry->children));
    if (entry->children == NULL) {
      close(child_fd);
      free_entries(&entries);
      return EXIT_IO_FAILED;
    }
    code = snapshot_tree(child_fd, root_device, depth + 1, entry->children);
    if (close(child_fd) != 0 && code == 0)
      code = EXIT_IO_FAILED;
    if (code != 0) {
      free_entries(&entries);
      return code;
    }
    struct stat current;
    if (fstatat(directory_fd, entry->name, &current, AT_SYMLINK_NOFOLLOW) !=
            0 ||
        !same_entry_identity(&entry->identity, &current)) {
      free_entries(&entries);
      return EXIT_MUTATION_DETECTED;
    }
  }

  EntryList verification = {0};
  code = stable_entries(directory_fd, root_device, &verification);
  if (code != 0 || !same_entries(&entries, &verification)) {
    free_entries(&entries);
    free_entries(&verification);
    return code == 0 ? EXIT_MUTATION_DETECTED : code;
  }
  free_entries(&verification);
  *result = entries;
  return 0;
}

static int manifest_write_identity(int descriptor,
                                   const struct stat *identity) {
#ifdef __APPLE__
  int64_t modified_seconds = identity->st_mtimespec.tv_sec;
  int64_t modified_nanoseconds = identity->st_mtimespec.tv_nsec;
  int64_t changed_seconds = identity->st_ctimespec.tv_sec;
  int64_t changed_nanoseconds = identity->st_ctimespec.tv_nsec;
#else
  int64_t modified_seconds = identity->st_mtim.tv_sec;
  int64_t modified_nanoseconds = identity->st_mtim.tv_nsec;
  int64_t changed_seconds = identity->st_ctim.tv_sec;
  int64_t changed_nanoseconds = identity->st_ctim.tv_nsec;
#endif
  return write_uint64(descriptor, (uint64_t)identity->st_dev) &&
         write_uint64(descriptor, (uint64_t)identity->st_ino) &&
         write_uint64(descriptor, (uint64_t)identity->st_mode) &&
         write_uint64(descriptor, (uint64_t)identity->st_size) &&
         write_uint64(descriptor, (uint64_t)modified_seconds) &&
         write_uint64(descriptor, (uint64_t)modified_nanoseconds) &&
         write_uint64(descriptor, (uint64_t)changed_seconds) &&
         write_uint64(descriptor, (uint64_t)changed_nanoseconds);
}

static int manifest_read_identity(int descriptor, struct stat *identity) {
  uint64_t device;
  uint64_t inode;
  uint64_t mode;
  uint64_t size;
  uint64_t modified_seconds;
  uint64_t modified_nanoseconds;
  uint64_t changed_seconds;
  uint64_t changed_nanoseconds;
  if (!read_uint64(descriptor, &device) || !read_uint64(descriptor, &inode) ||
      !read_uint64(descriptor, &mode) || !read_uint64(descriptor, &size) ||
      !read_uint64(descriptor, &modified_seconds) ||
      !read_uint64(descriptor, &modified_nanoseconds) ||
      !read_uint64(descriptor, &changed_seconds) ||
      !read_uint64(descriptor, &changed_nanoseconds)) {
    return 0;
  }
  memset(identity, 0, sizeof(*identity));
  identity->st_dev = (dev_t)device;
  identity->st_ino = (ino_t)inode;
  identity->st_mode = (mode_t)mode;
  identity->st_size = (off_t)(int64_t)size;
#ifdef __APPLE__
  identity->st_mtimespec.tv_sec = (time_t)(int64_t)modified_seconds;
  identity->st_mtimespec.tv_nsec = (long)(int64_t)modified_nanoseconds;
  identity->st_ctimespec.tv_sec = (time_t)(int64_t)changed_seconds;
  identity->st_ctimespec.tv_nsec = (long)(int64_t)changed_nanoseconds;
#else
  identity->st_mtim.tv_sec = (time_t)(int64_t)modified_seconds;
  identity->st_mtim.tv_nsec = (long)(int64_t)modified_nanoseconds;
  identity->st_ctim.tv_sec = (time_t)(int64_t)changed_seconds;
  identity->st_ctim.tv_nsec = (long)(int64_t)changed_nanoseconds;
#endif
  return (uint64_t)identity->st_dev == device &&
         (uint64_t)identity->st_ino == inode &&
         (uint64_t)identity->st_mode == mode &&
         (uint64_t)identity->st_size == size &&
         modified_nanoseconds <= UINT64_C(999999999) &&
         changed_nanoseconds <= UINT64_C(999999999);
}

static int write_manifest_entries(int descriptor, const EntryList *entries) {
  if (!write_uint64(descriptor, (uint64_t)entries->count))
    return 0;
  for (size_t index = 0; index < entries->count; index += 1) {
    const Entry *entry = &entries->items[index];
    size_t name_length = strlen(entry->name);
    if (name_length == 0 || name_length > NAME_MAX ||
        !write_uint64(descriptor, (uint64_t)name_length) ||
        !write_all(descriptor, entry->name, name_length) ||
        !manifest_write_identity(descriptor, &entry->identity) ||
        !write_uint64(descriptor, entry->children == NULL ? 0 : 1)) {
      return 0;
    }
    if (entry->children != NULL &&
        !write_manifest_entries(descriptor, entry->children)) {
      return 0;
    }
  }
  return 1;
}

static int read_manifest_entries(int descriptor, int depth,
                                 EntryList *entries) {
  if (depth > MAX_DEPTH)
    return 0;
  uint64_t encoded_count;
  if (!read_uint64(descriptor, &encoded_count) || encoded_count > MAX_ENTRIES ||
      total_entries > MAX_ENTRIES - (size_t)encoded_count) {
    return 0;
  }
  size_t count = (size_t)encoded_count;
  Entry *items = calloc(count == 0 ? 1 : count, sizeof(*items));
  if (items == NULL)
    return 0;
  total_entries += count;
  entries->items = items;
  entries->count = count;
  for (size_t index = 0; index < count; index += 1) {
    uint64_t encoded_name_length;
    uint64_t has_children;
    if (!read_uint64(descriptor, &encoded_name_length) ||
        encoded_name_length == 0 || encoded_name_length > NAME_MAX ||
        !read_all(descriptor, items[index].name, (size_t)encoded_name_length)) {
      free_entries(entries);
      return 0;
    }
    items[index].name[encoded_name_length] = '\0';
    if (memchr(items[index].name, '\0', (size_t)encoded_name_length) != NULL ||
        strcmp(items[index].name, ".") == 0 ||
        strcmp(items[index].name, "..") == 0 ||
        strchr(items[index].name, '/') != NULL ||
        !manifest_read_identity(descriptor, &items[index].identity) ||
        !read_uint64(descriptor, &has_children) || has_children > 1 ||
        (!S_ISDIR(items[index].identity.st_mode) &&
         !S_ISREG(items[index].identity.st_mode) &&
         !S_ISLNK(items[index].identity.st_mode)) ||
        (has_children == 1) != S_ISDIR(items[index].identity.st_mode) ||
        (index > 0 && strcmp(items[index - 1].name, items[index].name) >= 0)) {
      free_entries(entries);
      return 0;
    }
    if (has_children == 1) {
      items[index].children = calloc(1, sizeof(*items[index].children));
      if (items[index].children == NULL ||
          !read_manifest_entries(descriptor, depth + 1,
                                 items[index].children)) {
        free_entries(entries);
        return 0;
      }
    }
  }
  return 1;
}

static int sha256_manifest(int descriptor, char digest[SHA256_HEX_LENGTH + 1]) {
  if (lseek(descriptor, 0, SEEK_SET) < 0)
    return 0;
  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1)
    return 0;
  unsigned char buffer[64 * 1024];
  for (;;) {
    ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count > 0) {
      if (CC_SHA256_Update(&context, buffer, (CC_LONG)count) != 1)
        return 0;
      continue;
    }
    if (count < 0 && errno == EINTR)
      continue;
    if (count < 0)
      return 0;
    break;
  }
  unsigned char encoded[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256_Final(encoded, &context) != 1)
    return 0;
  for (size_t index = 0; index < sizeof(encoded); index += 1)
    (void)snprintf(digest + (index * 2), 3, "%02x", encoded[index]);
  digest[SHA256_HEX_LENGTH] = '\0';
  return 1;
}

static int sha256_update_uint64(CC_SHA256_CTX *context, uint64_t value) {
  unsigned char encoded[8];
  for (size_t index = 0; index < sizeof(encoded); index += 1) {
    encoded[sizeof(encoded) - 1 - index] =
        (unsigned char)(value & UINT64_C(0xff));
    value >>= 8;
  }
  return CC_SHA256_Update(context, encoded, (CC_LONG)sizeof(encoded)) == 1;
}

/*
 * Each entry binding transitively includes the full relative path through its
 * parent binding. The manifest digest already binds the root and complete
 * authorized tree; serializing the entry identity again makes the alias's
 * object binding explicit and domain-separated.
 */
static int
entry_binding(const char manifest_digest[SHA256_HEX_LENGTH + 1],
              const unsigned char parent_binding[CC_SHA256_DIGEST_LENGTH],
              const Entry *entry,
              unsigned char binding[CC_SHA256_DIGEST_LENGTH],
              char isolated_name[NAME_MAX + 1]) {
  static const char domain[] = "AIDEN-WORKTREE-ISOLATION-1";
  CC_SHA256_CTX context;
  size_t name_length = strlen(entry->name);
#ifdef __APPLE__
  int64_t modified_seconds = entry->identity.st_mtimespec.tv_sec;
  int64_t modified_nanoseconds = entry->identity.st_mtimespec.tv_nsec;
  int64_t changed_seconds = entry->identity.st_ctimespec.tv_sec;
  int64_t changed_nanoseconds = entry->identity.st_ctimespec.tv_nsec;
#else
  int64_t modified_seconds = entry->identity.st_mtim.tv_sec;
  int64_t modified_nanoseconds = entry->identity.st_mtim.tv_nsec;
  int64_t changed_seconds = entry->identity.st_ctim.tv_sec;
  int64_t changed_nanoseconds = entry->identity.st_ctim.tv_nsec;
#endif
  if (CC_SHA256_Init(&context) != 1 ||
      CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1)) != 1 ||
      CC_SHA256_Update(&context, manifest_digest, SHA256_HEX_LENGTH) != 1 ||
      CC_SHA256_Update(&context, parent_binding, CC_SHA256_DIGEST_LENGTH) !=
          1 ||
      !sha256_update_uint64(&context, (uint64_t)name_length) ||
      CC_SHA256_Update(&context, entry->name, (CC_LONG)name_length) != 1 ||
      !sha256_update_uint64(&context, (uint64_t)entry->identity.st_dev) ||
      !sha256_update_uint64(&context, (uint64_t)entry->identity.st_ino) ||
      !sha256_update_uint64(&context, (uint64_t)entry->identity.st_mode) ||
      !sha256_update_uint64(&context, (uint64_t)entry->identity.st_size) ||
      !sha256_update_uint64(&context, (uint64_t)modified_seconds) ||
      !sha256_update_uint64(&context, (uint64_t)modified_nanoseconds) ||
      !sha256_update_uint64(&context, (uint64_t)changed_seconds) ||
      !sha256_update_uint64(&context, (uint64_t)changed_nanoseconds) ||
      CC_SHA256_Final(binding, &context) != 1) {
    return 0;
  }

  size_t prefix_length = strlen(ISOLATION_PREFIX);
  memcpy(isolated_name, ISOLATION_PREFIX, prefix_length);
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    (void)snprintf(isolated_name + prefix_length + (index * 2), 3, "%02x",
                   binding[index]);
  }
  isolated_name[prefix_length + SHA256_HEX_LENGTH] = '\0';
  return 1;
}

static int root_binding(const char manifest_digest[SHA256_HEX_LENGTH + 1],
                        unsigned char binding[CC_SHA256_DIGEST_LENGTH]) {
  static const char domain[] = "AIDEN-WORKTREE-ISOLATION-ROOT-1";
  CC_SHA256_CTX context;
  return CC_SHA256_Init(&context) == 1 &&
         CC_SHA256_Update(&context, domain, (CC_LONG)(sizeof(domain) - 1)) ==
             1 &&
         CC_SHA256_Update(&context, manifest_digest, SHA256_HEX_LENGTH) == 1 &&
         CC_SHA256_Final(binding, &context) == 1;
}

static int persist_manifest(int parent_fd, const char *manifest_name,
                            const struct stat *target_identity,
                            const EntryList *entries,
                            char digest[SHA256_HEX_LENGTH + 1]) {
  int descriptor =
      openat(parent_fd, manifest_name,
             O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0)
    return errno == EEXIST ? EXIT_MUTATION_DETECTED : EXIT_IO_FAILED;
  int valid = write_all(descriptor, MANIFEST_MAGIC, MANIFEST_MAGIC_LENGTH) &&
              write_uint64(descriptor, (uint64_t)target_identity->st_dev) &&
              write_uint64(descriptor, (uint64_t)target_identity->st_ino) &&
              write_manifest_entries(descriptor, entries) &&
              fsync(descriptor) == 0 && sha256_manifest(descriptor, digest);
  int close_result = close(descriptor);
  if (!valid || close_result != 0) {
    (void)unlinkat(parent_fd, manifest_name, 0);
    return EXIT_IO_FAILED;
  }
  return fsync(parent_fd) == 0 ? 0 : EXIT_IO_FAILED;
}

static int load_manifest(int parent_fd, const char *manifest_name,
                         const struct stat *target_identity, EntryList *entries,
                         char digest[SHA256_HEX_LENGTH + 1]) {
  int descriptor =
      openat(parent_fd, manifest_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0)
    return errno == ENOENT ? EXIT_INVALID_INPUT : EXIT_IO_FAILED;
  struct stat manifest_identity;
  char magic[MANIFEST_MAGIC_LENGTH];
  uint64_t root_device;
  uint64_t root_inode;
  total_entries = 0;
  int valid = fstat(descriptor, &manifest_identity) == 0 &&
              S_ISREG(manifest_identity.st_mode) &&
              manifest_identity.st_uid == geteuid() &&
              (manifest_identity.st_mode & 0077) == 0 &&
              read_all(descriptor, magic, sizeof(magic)) &&
              memcmp(magic, MANIFEST_MAGIC, sizeof(magic)) == 0 &&
              read_uint64(descriptor, &root_device) &&
              read_uint64(descriptor, &root_inode) &&
              root_device == (uint64_t)target_identity->st_dev &&
              root_inode == (uint64_t)target_identity->st_ino &&
              read_manifest_entries(descriptor, 0, entries);
  unsigned char trailing;
  ssize_t trailing_count = valid ? read(descriptor, &trailing, 1) : -1;
  valid = valid && trailing_count == 0 && sha256_manifest(descriptor, digest);
  int close_result = close(descriptor);
  if (!valid || close_result != 0) {
    free_entries(entries);
    return EXIT_MUTATION_DETECTED;
  }
  return 0;
}

/*
 * Capture the exact authorized sidecar before unlinking it. A concurrent
 * replacement at the public reserved name is either excluded by the rename or
 * fails the inode/digest check under the finalizing name and is preserved.
 */
static int
verify_manifest_capture(int parent_fd, const char *capture_name,
                        const struct stat *expected_identity,
                        const char expected_digest[SHA256_HEX_LENGTH + 1],
                        struct stat *captured_identity) {
  int descriptor =
      openat(parent_fd, capture_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0)
    return errno == ELOOP || errno == ENOENT ? EXIT_MUTATION_DETECTED
                                             : EXIT_IO_FAILED;
  struct stat captured;
  char captured_digest[SHA256_HEX_LENGTH + 1] = {0};
  int valid = fstat(descriptor, &captured) == 0 && S_ISREG(captured.st_mode) &&
              captured.st_uid == geteuid() && (captured.st_mode & 0077) == 0 &&
              captured.st_nlink == 1 &&
              (expected_identity == NULL ||
               same_object_identity(expected_identity, &captured)) &&
              sha256_manifest(descriptor, captured_digest) &&
              strcmp(captured_digest, expected_digest) == 0;
  int close_result = close(descriptor);
  if (!valid)
    return EXIT_MUTATION_DETECTED;
  if (close_result != 0)
    return EXIT_IO_FAILED;
  *captured_identity = captured;
  return 0;
}

static int inspect_manifest_stages(int parent_fd, const char *manifest_name,
                                   const char *finalizing_name,
                                   const char *deleting_name, int *stage,
                                   int *count) {
  const char *names[] = {manifest_name, finalizing_name, deleting_name};
  *stage = -1;
  *count = 0;
  for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index += 1) {
    struct stat identity;
    if (fstatat(parent_fd, names[index], &identity, AT_SYMLINK_NOFOLLOW) == 0) {
      *stage = (int)index;
      *count += 1;
      continue;
    }
    if (errno != ENOENT)
      return EXIT_IO_FAILED;
  }
  return 0;
}

static int
finalize_manifest(int parent_fd, const char *manifest_name,
                  const char *finalizing_name, const char *deleting_name,
                  const struct stat *expected_identity,
                  const char expected_digest[SHA256_HEX_LENGTH + 1]) {
  int stage;
  int count;
  int code = inspect_manifest_stages(parent_fd, manifest_name, finalizing_name,
                                     deleting_name, &stage, &count);
  if (code != 0)
    return code;
  if (count == 0) {
    if (expected_identity != NULL)
      return EXIT_MUTATION_DETECTED;
    if (fsync(parent_fd) != 0)
      return EXIT_IO_FAILED;
    code = inspect_manifest_stages(parent_fd, manifest_name, finalizing_name,
                                   deleting_name, &stage, &count);
    return code != 0 ? code : count == 0 ? 0 : EXIT_MUTATION_DETECTED;
  }
  if (count != 1 || (expected_identity != NULL && stage != 0))
    return EXIT_MUTATION_DETECTED;

  const char *stage_names[] = {manifest_name, finalizing_name, deleting_name};
  struct stat captured;
  code = verify_manifest_capture(parent_fd, stage_names[stage],
                                 stage == 0 ? expected_identity : NULL,
                                 expected_digest, &captured);
  if (code != 0)
    return code;

  if (stage == 0) {
    code = test_pause("AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_FINALIZING");
    if (code != 0)
      return code;
    if (renameatx_np(parent_fd, manifest_name, parent_fd, finalizing_name,
                     RENAME_EXCL) != 0) {
      return errno == EEXIST || errno == ENOENT ? EXIT_MUTATION_DETECTED
                                                : EXIT_IO_FAILED;
    }
    if (fsync(parent_fd) != 0)
      return EXIT_IO_FAILED;
    struct stat finalizing_identity;
    code = verify_manifest_capture(parent_fd, finalizing_name, &captured,
                                   expected_digest, &finalizing_identity);
    if (code != 0)
      return code;
    captured = finalizing_identity;
    stage = 1;
  }
  if (stage == 1) {
    code = test_pause("AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_TO_DELETING");
    if (code != 0)
      return code;
    if (renameatx_np(parent_fd, finalizing_name, parent_fd, deleting_name,
                     RENAME_EXCL) != 0) {
      return errno == EEXIST || errno == ENOENT ? EXIT_MUTATION_DETECTED
                                                : EXIT_IO_FAILED;
    }
    if (fsync(parent_fd) != 0)
      return EXIT_IO_FAILED;
    struct stat deleting_identity;
    code = verify_manifest_capture(parent_fd, deleting_name, &captured,
                                   expected_digest, &deleting_identity);
    if (code != 0)
      return code;
    captured = deleting_identity;
  }

  struct stat current;
  if (fstatat(parent_fd, deleting_name, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_object_identity(&captured, &current)) {
    return EXIT_MUTATION_DETECTED;
  }
  code = delete_validated_entry(
      parent_fd, deleting_name, &current, same_object_identity,
      "AIDEN_REMOVER_TEST_PAUSE_BEFORE_MANIFEST_DELETE_CAPTURE", 0);
  if (code != 0)
    return code;
  if (fstatat(parent_fd, deleting_name, &current, AT_SYMLINK_NOFOLLOW) == 0)
    return EXIT_MUTATION_DETECTED;
  if (errno != ENOENT)
    return EXIT_IO_FAILED;
  code = inspect_manifest_stages(parent_fd, manifest_name, finalizing_name,
                                 deleting_name, &stage, &count);
  return code != 0 ? code : count == 0 ? 0 : EXIT_MUTATION_DETECTED;
}

static int same_resumable_entry_identity(const struct stat *expected,
                                         const struct stat *current) {
  if (!S_ISDIR(expected->st_mode))
    return same_entry_identity(expected, current);
  return S_ISDIR(current->st_mode) && expected->st_dev == current->st_dev &&
         expected->st_ino == current->st_ino &&
         expected->st_mode == current->st_mode;
}

static int find_entry(const EntryList *entries, const char *name,
                      size_t *index) {
  size_t lower = 0;
  size_t upper = entries->count;
  while (lower < upper) {
    size_t middle = lower + ((upper - lower) / 2);
    int comparison = strcmp(entries->items[middle].name, name);
    if (comparison < 0)
      lower = middle + 1;
    else
      upper = middle;
  }
  if (lower >= entries->count ||
      strcmp(entries->items[lower].name, name) != 0) {
    return 0;
  }
  *index = lower;
  return 1;
}

static int validate_manifest_subset(
    int directory_fd, dev_t root_device, int depth, const EntryList *manifest,
    const char manifest_digest[SHA256_HEX_LENGTH + 1],
    const unsigned char parent_binding[CC_SHA256_DIGEST_LENGTH],
    int resume_authorized) {
  if (depth > MAX_DEPTH)
    return EXIT_MUTATION_DETECTED;
  EntryList current = {0};
  int code = stable_entries(directory_fd, root_device, &current);
  if (code != 0)
    return code;

  unsigned char *seen = calloc(current.count == 0 ? 1 : current.count, 1);
  if (seen == NULL) {
    free_entries(&current);
    return EXIT_IO_FAILED;
  }
  for (size_t manifest_index = 0; manifest_index < manifest->count;
       manifest_index += 1) {
    const Entry *entry = &manifest->items[manifest_index];
    if (strncmp(entry->name, ISOLATION_PREFIX, strlen(ISOLATION_PREFIX)) == 0) {
      code = EXIT_MUTATION_DETECTED;
      break;
    }
    unsigned char child_binding[CC_SHA256_DIGEST_LENGTH];
    char isolated_name[NAME_MAX + 1] = {0};
    if (!entry_binding(manifest_digest, parent_binding, entry, child_binding,
                       isolated_name)) {
      code = EXIT_IO_FAILED;
      break;
    }
    size_t original_index = 0;
    size_t isolated_index = 0;
    int original_exists = find_entry(&current, entry->name, &original_index);
    int isolated_exists = find_entry(&current, isolated_name, &isolated_index);
    if (original_exists && isolated_exists) {
      code = EXIT_MUTATION_DETECTED;
      break;
    }
    if (!original_exists && !isolated_exists) {
      if (!resume_authorized) {
        code = EXIT_MUTATION_DETECTED;
        break;
      }
      continue;
    }
    size_t current_index = original_exists ? original_index : isolated_index;
    if (seen[current_index] != 0) {
      code = EXIT_MUTATION_DETECTED;
      break;
    }
    seen[current_index] = 1;
    const struct stat *current_identity =
        &current.items[current_index].identity;
    int identity_matches =
        isolated_exists
            ? (S_ISDIR(entry->identity.st_mode)
                   ? same_directory_identity(&entry->identity, current_identity)
                   : same_object_identity(&entry->identity, current_identity))
            : (resume_authorized
                   ? same_resumable_entry_identity(&entry->identity,
                                                   current_identity)
                   : same_entry_identity(&entry->identity, current_identity));
    if (!identity_matches) {
      code = EXIT_MUTATION_DETECTED;
      break;
    }
    if (S_ISDIR(current_identity->st_mode)) {
      const char *current_name = isolated_exists ? isolated_name : entry->name;
      int child_fd = openat(directory_fd, current_name,
                            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child_fd < 0) {
        code = errno == ELOOP || errno == ENOENT ? EXIT_MUTATION_DETECTED
                                                 : EXIT_IO_FAILED;
        break;
      }
      struct stat child_identity;
      if (fstat(child_fd, &child_identity) != 0 ||
          !same_directory_identity(current_identity, &child_identity) ||
          entry->children == NULL) {
        close(child_fd);
        code = EXIT_MUTATION_DETECTED;
        break;
      }
      code = validate_manifest_subset(child_fd, root_device, depth + 1,
                                      entry->children, manifest_digest,
                                      child_binding, resume_authorized);
      if (close(child_fd) != 0 && code == 0)
        code = EXIT_IO_FAILED;
      if (code != 0)
        break;
    }
  }
  if (code == 0) {
    for (size_t index = 0; index < current.count; index += 1) {
      if (seen[index] == 0) {
        code = EXIT_MUTATION_DETECTED;
        break;
      }
    }
  }
  free(seen);
  free_entries(&current);
  return code;
}

#ifdef AIDEN_REMOVER_TESTING
static int test_pause(const char *environment_name) {
  const char *marker = getenv(environment_name);
  if (marker == NULL || marker[0] == '\0')
    return 0;
  int marker_fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (marker_fd < 0)
    return EXIT_IO_FAILED;
  char process_id[32];
  int process_id_length =
      snprintf(process_id, sizeof(process_id), "%ld\n", (long)getpid());
  if (process_id_length <= 0 || process_id_length >= (int)sizeof(process_id) ||
      !write_all(marker_fd, process_id, (size_t)process_id_length) ||
      fsync(marker_fd) != 0 || close(marker_fd) != 0)
    return EXIT_IO_FAILED;
  char continuation[PATH_MAX];
  if (snprintf(continuation, sizeof(continuation), "%s.continue", marker) >=
      (int)sizeof(continuation)) {
    return EXIT_INVALID_INPUT;
  }
  for (int attempt = 0; attempt < 3000; attempt += 1) {
    if (access(continuation, F_OK) == 0)
      return 0;
    if (errno != ENOENT)
      return EXIT_IO_FAILED;
    usleep(10000);
  }
  return EXIT_IO_FAILED;
}
#else
static int test_pause(const char *environment_name) {
  (void)environment_name;
  return 0;
}
#endif

static int make_capture_name(char output[NAME_MAX + 1]) {
  static const char hex[] = "0123456789abcdef";
  unsigned char random[16];
  arc4random_buf(random, sizeof(random));
  size_t prefix_length = strlen(CAPTURE_PREFIX);
  if (prefix_length + (sizeof(random) * 2) > NAME_MAX)
    return 0;
  memcpy(output, CAPTURE_PREFIX, prefix_length);
  for (size_t index = 0; index < sizeof(random); index += 1) {
    output[prefix_length + (index * 2)] = hex[random[index] >> 4];
    output[prefix_length + (index * 2) + 1] = hex[random[index] & 0x0f];
  }
  output[prefix_length + (sizeof(random) * 2)] = '\0';
  return 1;
}

/*
 * Move a validated entry to an unpredictable, process-owned name before any
 * pathname-based deletion. If the public source was replaced after validation,
 * the rename captures the replacement, the identity check rejects it, and the
 * replacement is restored whenever the source name is still free.
 */
static int capture_validated_entry(int directory_fd, const char *source_name,
                                   const struct stat *expected,
                                   IdentityMatcher identity_matches,
                                   const char *pause_environment,
                                   char capture_name[NAME_MAX + 1],
                                   struct stat *captured_identity) {
  if (pause_environment != NULL) {
    int pause_code = test_pause(pause_environment);
    if (pause_code != 0)
      return pause_code;
  }

  int captured = 0;
  for (int attempt = 0; attempt < MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    if (!make_capture_name(capture_name))
      return EXIT_IO_FAILED;
    if (renameatx_np(directory_fd, source_name, directory_fd, capture_name,
                     RENAME_EXCL) == 0) {
      captured = 1;
      break;
    }
    if (errno == ENOENT)
      return EXIT_MUTATION_DETECTED;
    if (errno != EEXIST)
      return EXIT_IO_FAILED;
  }
  if (!captured)
    return EXIT_IO_FAILED;

  struct stat current;
  if (fstatat(directory_fd, capture_name, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !identity_matches(expected, &current)) {
    (void)renameatx_np(directory_fd, capture_name, directory_fd, source_name,
                       RENAME_EXCL);
    (void)fsync(directory_fd);
    return EXIT_MUTATION_DETECTED;
  }
  if (fsync(directory_fd) != 0) {
    (void)renameatx_np(directory_fd, capture_name, directory_fd, source_name,
                       RENAME_EXCL);
    (void)fsync(directory_fd);
    return EXIT_IO_FAILED;
  }
  *captured_identity = current;
  return 0;
}

static int delete_validated_entry(int directory_fd, const char *source_name,
                                  const struct stat *expected,
                                  IdentityMatcher identity_matches,
                                  const char *pause_environment,
                                  int unlink_flags) {
  char capture_name[NAME_MAX + 1] = {0};
  struct stat captured;
  int code = capture_validated_entry(directory_fd, source_name, expected,
                                     identity_matches, pause_environment,
                                     capture_name, &captured);
  if (code != 0)
    return code;
  if (unlinkat(directory_fd, capture_name, unlink_flags) != 0) {
    int unlink_error = errno;
    (void)renameatx_np(directory_fd, capture_name, directory_fd, source_name,
                       RENAME_EXCL);
    (void)fsync(directory_fd);
    if (unlink_error == ENOENT || unlink_error == ENOTEMPTY)
      return EXIT_MUTATION_DETECTED;
    return EXIT_IO_FAILED;
  }
  return fsync(directory_fd) == 0 ? 0 : EXIT_IO_FAILED;
}

/*
 * Atomically move the directory entry away from its attacker-controlled name
 * before deleting it. The rename captures exactly one object; only that
 * captured object is removed after its identity is revalidated. If another
 * process wins the race and supplies a replacement, restore it when possible
 * and otherwise leave it under the isolation name for manual recovery.
 */
static int isolate_entry(int directory_fd, const char *name,
                         const struct stat *expected,
                         const char *pause_environment,
                         const char *isolated_name,
                         struct stat *captured_identity) {
  if (pause_environment != NULL) {
    int pause_code = test_pause(pause_environment);
    if (pause_code != 0)
      return pause_code;
  }

  if (renameatx_np(directory_fd, name, directory_fd, isolated_name,
                   RENAME_EXCL) != 0) {
    return errno == ENOENT || errno == EEXIST ? EXIT_MUTATION_DETECTED
                                              : EXIT_IO_FAILED;
  }

  struct stat captured;
  if (fstatat(directory_fd, isolated_name, &captured, AT_SYMLINK_NOFOLLOW) !=
          0 ||
      !same_object_identity(expected, &captured)) {
    /*
     * RENAME_EXCL will restore only if the original name is still absent. If a
     * late entry occupies it, preserve both names and fail closed.
     */
    (void)renameatx_np(directory_fd, isolated_name, directory_fd, name,
                       RENAME_EXCL);
    return EXIT_MUTATION_DETECTED;
  }
  *captured_identity = captured;
  return fsync(directory_fd) == 0 ? 0 : EXIT_IO_FAILED;
}

static void restore_isolated_entry(int directory_fd, const char *isolated_name,
                                   const char *original_name) {
  (void)renameatx_np(directory_fd, isolated_name, directory_fd, original_name,
                     RENAME_EXCL);
}

static int
authorization_barrier(const char *isolated_name,
                      const char manifest_digest[SHA256_HEX_LENGTH + 1],
                      int *resume_authorized) {
  if (isolated_name == NULL ||
      fprintf(stdout, "ready:%s:%s\n", isolated_name, manifest_digest) < 0 ||
      fflush(stdout) != 0) {
    return EXIT_IO_FAILED;
  }
  char response[sizeof("resume:") + SHA256_HEX_LENGTH + sizeof("\n")] = {0};
  size_t received = 0;
  while (received < sizeof(response) - 1) {
    ssize_t count = read(STDIN_FILENO, response + received, 1);
    if (count > 0) {
      received += (size_t)count;
      if (response[received - 1] == '\n')
        break;
      continue;
    }
    if (count < 0 && errno == EINTR)
      continue;
    return EXIT_IO_FAILED;
  }
  if (strcmp(response, "continue\n") == 0) {
    *resume_authorized = 0;
    return 0;
  }
  char expected_resume[sizeof(response)];
  int expected_length = snprintf(expected_resume, sizeof(expected_resume),
                                 "resume:%s\n", manifest_digest);
  if (expected_length > 0 && expected_length < (int)sizeof(expected_resume) &&
      strcmp(response, expected_resume) == 0) {
    *resume_authorized = 1;
    return 0;
  }
  if (strcmp(response, "abort\n") == 0)
    return EXIT_AUTHORIZATION_ABORTED;
  return EXIT_IO_FAILED;
}

static int
remove_contents(int directory_fd, dev_t root_device, int depth,
                EntryList *entries, int resume_authorized,
                const char manifest_digest[SHA256_HEX_LENGTH + 1],
                const unsigned char parent_binding[CC_SHA256_DIGEST_LENGTH]) {
  if (depth > MAX_DEPTH)
    return EXIT_MUTATION_DETECTED;
  for (size_t index = 0; index < entries->count; index += 1) {
    Entry *entry = &entries->items[index];
    unsigned char child_binding[CC_SHA256_DIGEST_LENGTH];
    char isolated_name[NAME_MAX + 1] = {0};
    if (!entry_binding(manifest_digest, parent_binding, entry, child_binding,
                       isolated_name)) {
      return EXIT_IO_FAILED;
    }
    struct stat current;
    struct stat isolated;
    int original_exists =
        fstatat(directory_fd, entry->name, &current, AT_SYMLINK_NOFOLLOW) == 0;
    int original_error = errno;
    int isolated_exists = fstatat(directory_fd, isolated_name, &isolated,
                                  AT_SYMLINK_NOFOLLOW) == 0;
    int isolated_error = errno;
    if (!original_exists && original_error != ENOENT)
      return EXIT_IO_FAILED;
    if (!isolated_exists && isolated_error != ENOENT)
      return EXIT_IO_FAILED;
    if (original_exists && isolated_exists)
      return EXIT_MUTATION_DETECTED;
    if (!original_exists && !isolated_exists) {
      if (resume_authorized)
        continue;
      return EXIT_MUTATION_DETECTED;
    }
    int already_isolated = isolated_exists;
    if (already_isolated)
      current = isolated;
    int identity_matches =
        already_isolated
            ? (S_ISDIR(entry->identity.st_mode)
                   ? same_directory_identity(&entry->identity, &current)
                   : same_object_identity(&entry->identity, &current))
            : (resume_authorized
                   ? same_resumable_entry_identity(&entry->identity, &current)
                   : same_entry_identity(&entry->identity, &current));
    if (!identity_matches || (already_isolated && !resume_authorized)) {
      return EXIT_MUTATION_DETECTED;
    }

    struct stat captured_identity;
    int code = 0;
    if (already_isolated) {
      captured_identity = current;
    } else {
      const struct stat *isolation_identity =
          resume_authorized && S_ISDIR(current.st_mode) ? &current
                                                        : &entry->identity;
      code =
          isolate_entry(directory_fd, entry->name, isolation_identity,
                        depth == 0 && index == 0
                            ? "AIDEN_REMOVER_TEST_PAUSE_BEFORE_ENTRY_ISOLATION"
                            : NULL,
                        isolated_name, &captured_identity);
      if (code != 0)
        return code;
    }

    if (S_ISDIR(current.st_mode)) {
      int child_fd = openat(directory_fd, isolated_name,
                            O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child_fd < 0) {
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return errno == ELOOP || errno == ENOENT ? EXIT_MUTATION_DETECTED
                                                 : EXIT_IO_FAILED;
      }
      struct stat child_identity;
      if (fstat(child_fd, &child_identity) != 0 ||
          !same_directory_identity(&captured_identity, &child_identity)) {
        close(child_fd);
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return EXIT_MUTATION_DETECTED;
      }
      if (entry->children == NULL) {
        close(child_fd);
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return EXIT_MUTATION_DETECTED;
      }
#ifdef AIDEN_REMOVER_TESTING
      const char *pause_directory_name =
          getenv("AIDEN_REMOVER_TEST_PAUSE_AFTER_DIRECTORY_ISOLATION_NAME");
      if (pause_directory_name != NULL &&
          strcmp(entry->name, pause_directory_name) == 0) {
        code = test_pause("AIDEN_REMOVER_TEST_PAUSE_AFTER_DIRECTORY_ISOLATION");
        if (code != 0) {
          close(child_fd);
          return code;
        }
      }
#endif
      code = remove_contents(child_fd, root_device, depth + 1, entry->children,
                             resume_authorized, manifest_digest, child_binding);
      if (close(child_fd) != 0 && code == 0)
        code = EXIT_IO_FAILED;
      if (code != 0) {
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return code;
      }
      if (fstatat(directory_fd, isolated_name, &current, AT_SYMLINK_NOFOLLOW) !=
              0 ||
          !same_directory_identity(&captured_identity, &current)) {
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return EXIT_MUTATION_DETECTED;
      }
      const char *capture_pause = NULL;
#ifdef AIDEN_REMOVER_TESTING
      const char *capture_name =
          getenv("AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE_NAME");
      if (capture_name != NULL && strcmp(entry->name, capture_name) == 0)
        capture_pause = "AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE";
#endif
      code = delete_validated_entry(directory_fd, isolated_name, &current,
                                    same_directory_identity, capture_pause,
                                    AT_REMOVEDIR);
      if (code != 0) {
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return code;
      }
    } else {
      if (fstatat(directory_fd, isolated_name, &current, AT_SYMLINK_NOFOLLOW) !=
              0 ||
          !same_entry_identity(&captured_identity, &current)) {
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return EXIT_MUTATION_DETECTED;
      }
      const char *capture_pause = NULL;
#ifdef AIDEN_REMOVER_TESTING
      const char *capture_name =
          getenv("AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE_NAME");
      if (capture_name != NULL && strcmp(entry->name, capture_name) == 0)
        capture_pause = "AIDEN_REMOVER_TEST_PAUSE_BEFORE_ISOLATED_CAPTURE";
#endif
      code = delete_validated_entry(directory_fd, isolated_name, &current,
                                    same_object_identity, capture_pause, 0);
      if (code != 0) {
        restore_isolated_entry(directory_fd, isolated_name, entry->name);
        return code;
      }
#ifdef AIDEN_REMOVER_TESTING
      const char *pause_name =
          getenv("AIDEN_REMOVER_TEST_PAUSE_AFTER_UNLINK_NAME");
      if (pause_name != NULL && strcmp(entry->name, pause_name) == 0) {
        if (fsync(directory_fd) != 0)
          return EXIT_IO_FAILED;
        code = test_pause("AIDEN_REMOVER_TEST_PAUSE_AFTER_UNLINK");
        if (code != 0)
          return code;
      }
#endif
    }
  }

  EntryList remaining = {0};
  int code = read_entries(directory_fd, root_device, &remaining);
  if (code != 0)
    return code;
  int empty = remaining.count == 0;
  free_entries(&remaining);
  if (!empty)
    return EXIT_MUTATION_DETECTED;
  return fsync(directory_fd) == 0 ? 0 : EXIT_IO_FAILED;
}

static int parse_uint64(const char *value, uint64_t *result) {
  if (value == NULL || value[0] == '\0' || value[0] == '-')
    return 0;
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0')
    return 0;
  *result = (uint64_t)parsed;
  return 1;
}

static int valid_name(const char *name) {
  return name != NULL && name[0] != '\0' && strcmp(name, ".") != 0 &&
         strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static int valid_token(const char *token) {
  if (token == NULL || token[0] == '\0')
    return 0;
  for (const unsigned char *cursor = (const unsigned char *)token;
       *cursor != '\0'; cursor += 1) {
    if ((*cursor >= 'a' && *cursor <= 'z') ||
        (*cursor >= 'A' && *cursor <= 'Z') ||
        (*cursor >= '0' && *cursor <= '9') || *cursor == '.' ||
        *cursor == '_' || *cursor == '-') {
      continue;
    }
    return 0;
  }
  return 1;
}

static int root_names(const char *input_name,
                      char quarantine_name[NAME_MAX + 1],
                      char authorization_name[NAME_MAX + 1],
                      int *requires_rename) {
  const char *token = NULL;
  size_t quarantine_prefix_length = strlen(QUARANTINE_PREFIX);
  size_t authorization_prefix_length = strlen(AUTHORIZATION_PREFIX);
  if (strncmp(input_name, QUARANTINE_PREFIX, quarantine_prefix_length) == 0) {
    token = input_name + quarantine_prefix_length;
    *requires_rename = 1;
  } else if (strncmp(input_name, AUTHORIZATION_PREFIX,
                     authorization_prefix_length) == 0) {
    token = input_name + authorization_prefix_length;
    *requires_rename = 0;
  } else {
    return 0;
  }
  if (!valid_token(token))
    return 0;
  int quarantine_length =
      snprintf(quarantine_name, NAME_MAX + 1, "%s%s", QUARANTINE_PREFIX, token);
  int authorization_length = snprintf(authorization_name, NAME_MAX + 1, "%s%s",
                                      AUTHORIZATION_PREFIX, token);
  return quarantine_length >= 0 && quarantine_length <= NAME_MAX &&
         authorization_length >= 0 && authorization_length <= NAME_MAX;
}

static int restore_root(int parent_fd, const char *authorization_name,
                        const char *quarantine_name) {
  if (renameatx_np(parent_fd, authorization_name, parent_fd, quarantine_name,
                   RENAME_EXCL) != 0) {
    return errno == EEXIST || errno == ENOENT ? EXIT_IDENTITY_CHANGED
                                              : EXIT_IO_FAILED;
  }
  return fsync(parent_fd) == 0 ? 0 : EXIT_IO_FAILED;
}

static int manifest_names(const char *token, char manifest_name[NAME_MAX + 1],
                          char finalizing_name[NAME_MAX + 1],
                          char deleting_name[NAME_MAX + 1]) {
  int manifest_length =
      snprintf(manifest_name, NAME_MAX + 1, "%s%s", MANIFEST_PREFIX, token);
  int finalizing_length = snprintf(finalizing_name, NAME_MAX + 1, "%s%s",
                                   manifest_name, MANIFEST_FINALIZING_SUFFIX);
  int deleting_length = snprintf(deleting_name, NAME_MAX + 1, "%s%s",
                                 manifest_name, MANIFEST_DELETING_SUFFIX);
  return manifest_length >= 0 && manifest_length <= NAME_MAX &&
         finalizing_length >= 0 && finalizing_length <= NAME_MAX &&
         deleting_length >= 0 && deleting_length <= NAME_MAX;
}

static int valid_digest(const char *digest) {
  if (digest == NULL || strlen(digest) != SHA256_HEX_LENGTH)
    return 0;
  for (size_t index = 0; index < SHA256_HEX_LENGTH; index += 1) {
    if (!((digest[index] >= '0' && digest[index] <= '9') ||
          (digest[index] >= 'a' && digest[index] <= 'f'))) {
      return 0;
    }
  }
  return 1;
}

static void print_error(int code) {
  if (code == EXIT_MUTATION_DETECTED)
    fputs("mutation_detected\n", stderr);
  else if (code == EXIT_IO_FAILED)
    fputs("io_failed\n", stderr);
  else if (code == EXIT_INVALID_INPUT)
    fputs("invalid_input\n", stderr);
}

static int finalize_manifest_command(int argc, char **argv) {
  if (argc != 8 || strcmp(argv[2], "--parent") != 0 ||
      strcmp(argv[4], "--token") != 0 || strcmp(argv[6], "--digest") != 0 ||
      argv[3][0] != '/' || !valid_token(argv[5]) || !valid_digest(argv[7])) {
    print_error(EXIT_INVALID_INPUT);
    return EXIT_INVALID_INPUT;
  }
  char manifest_name[NAME_MAX + 1] = {0};
  char finalizing_name[NAME_MAX + 1] = {0};
  char deleting_name[NAME_MAX + 1] = {0};
  if (!manifest_names(argv[5], manifest_name, finalizing_name, deleting_name)) {
    print_error(EXIT_INVALID_INPUT);
    return EXIT_INVALID_INPUT;
  }
  int parent_fd =
      open(argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0) {
    print_error(EXIT_IO_FAILED);
    return EXIT_IO_FAILED;
  }
  int code = finalize_manifest(parent_fd, manifest_name, finalizing_name,
                               deleting_name, NULL, argv[7]);
  if (close(parent_fd) != 0 && code == 0)
    code = EXIT_IO_FAILED;
  print_error(code);
  return code;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "finalize-manifest") == 0)
    return finalize_manifest_command(argc, argv);
  if (argc != 12 || strcmp(argv[1], "remove") != 0 ||
      strcmp(argv[2], "--parent") != 0 || strcmp(argv[4], "--name") != 0 ||
      strcmp(argv[6], "--device") != 0 || strcmp(argv[8], "--inode") != 0 ||
      strcmp(argv[10], "--manifest-mode") != 0 ||
      (strcmp(argv[11], "fresh") != 0 && strcmp(argv[11], "resume") != 0) ||
      argv[3][0] != '/' || !valid_name(argv[5])) {
    fputs("invalid_input\n", stderr);
    return EXIT_INVALID_INPUT;
  }
  char quarantine_name[NAME_MAX + 1] = {0};
  char authorization_name[NAME_MAX + 1] = {0};
  char manifest_name[NAME_MAX + 1] = {0};
  char manifest_finalizing_name[NAME_MAX + 1] = {0};
  char manifest_deleting_name[NAME_MAX + 1] = {0};
  int requires_rename = 0;
  if (!root_names(argv[5], quarantine_name, authorization_name,
                  &requires_rename)) {
    fputs("invalid_input\n", stderr);
    return EXIT_INVALID_INPUT;
  }
  const char *token = quarantine_name + strlen(QUARANTINE_PREFIX);
  if (!manifest_names(token, manifest_name, manifest_finalizing_name,
                      manifest_deleting_name)) {
    fputs("invalid_input\n", stderr);
    return EXIT_INVALID_INPUT;
  }
  uint64_t expected_device;
  uint64_t expected_inode;
  if (!parse_uint64(argv[7], &expected_device) ||
      !parse_uint64(argv[9], &expected_inode)) {
    fputs("invalid_input\n", stderr);
    return EXIT_INVALID_INPUT;
  }

  int parent_fd =
      open(argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (parent_fd < 0) {
    fputs("io_failed\n", stderr);
    return EXIT_IO_FAILED;
  }

  int code = 0;
  int root_isolated = !requires_rename;
  if (requires_rename)
    code = test_pause("AIDEN_REMOVER_TEST_PAUSE_BEFORE_ROOT");
  if (code == 0 && requires_rename &&
      renameatx_np(parent_fd, quarantine_name, parent_fd, authorization_name,
                   RENAME_EXCL) != 0) {
    code = errno == ENOENT || errno == EEXIST ? EXIT_IDENTITY_CHANGED
                                              : EXIT_IO_FAILED;
  }
  if (code == 0)
    root_isolated = 1;

  int target_fd = -1;
  if (code == 0) {
    target_fd = openat(parent_fd, authorization_name,
                       O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  }
  if (target_fd < 0) {
    int open_error = errno;
    if (root_isolated && requires_rename)
      (void)restore_root(parent_fd, authorization_name, quarantine_name);
    close(parent_fd);
    if (code == 0)
      code = open_error == ELOOP || open_error == ENOENT ? EXIT_IDENTITY_CHANGED
                                                         : EXIT_IO_FAILED;
    fputs(code == EXIT_IDENTITY_CHANGED ? "identity_changed\n" : "io_failed\n",
          stderr);
    return code;
  }
  struct stat target_identity;
  if (fstat(target_fd, &target_identity) != 0 ||
      !S_ISDIR(target_identity.st_mode) ||
      (uint64_t)target_identity.st_dev != expected_device ||
      (uint64_t)target_identity.st_ino != expected_inode) {
    close(target_fd);
    if (requires_rename)
      (void)restore_root(parent_fd, authorization_name, quarantine_name);
    close(parent_fd);
    fputs("identity_changed\n", stderr);
    return EXIT_IDENTITY_CHANGED;
  }

  EntryList snapshot = {0};
  char manifest_digest[SHA256_HEX_LENGTH + 1] = {0};
  struct stat manifest_identity;
  int manifest_exists = fstatat(parent_fd, manifest_name, &manifest_identity,
                                AT_SYMLINK_NOFOLLOW) == 0;
  if (!manifest_exists && errno != ENOENT)
    code = EXIT_IO_FAILED;
  int manifest_resume = strcmp(argv[11], "resume") == 0;
  if (code == 0 && !manifest_resume && manifest_exists) {
    if (unlinkat(parent_fd, manifest_name, 0) != 0 || fsync(parent_fd) != 0) {
      code = EXIT_MUTATION_DETECTED;
    }
    manifest_exists = 0;
  }
  if (code == 0 && manifest_resume && !manifest_exists)
    code = EXIT_MUTATION_DETECTED;
  if (code == 0 && manifest_resume) {
    code = load_manifest(parent_fd, manifest_name, &target_identity, &snapshot,
                         manifest_digest);
  } else if (code == 0) {
    total_entries = 0;
    code = snapshot_tree(target_fd, target_identity.st_dev, 0, &snapshot);
    if (code == 0)
      code = persist_manifest(parent_fd, manifest_name, &target_identity,
                              &snapshot, manifest_digest);
  }
  if (code == 0 && (fstatat(parent_fd, manifest_name, &manifest_identity,
                            AT_SYMLINK_NOFOLLOW) != 0 ||
                    !S_ISREG(manifest_identity.st_mode) ||
                    manifest_identity.st_uid != geteuid() ||
                    (manifest_identity.st_mode & 0077) != 0 ||
                    manifest_identity.st_nlink != 1)) {
    code = EXIT_MUTATION_DETECTED;
  }
  struct stat unexpected_finalizing;
  if (code == 0 && fstatat(parent_fd, manifest_finalizing_name,
                           &unexpected_finalizing, AT_SYMLINK_NOFOLLOW) == 0) {
    code = EXIT_MUTATION_DETECTED;
  } else if (code == 0 && errno != ENOENT) {
    code = EXIT_IO_FAILED;
  }
  struct stat unexpected_deleting;
  if (code == 0 && fstatat(parent_fd, manifest_deleting_name,
                           &unexpected_deleting, AT_SYMLINK_NOFOLLOW) == 0) {
    code = EXIT_MUTATION_DETECTED;
  } else if (code == 0 && errno != ENOENT) {
    code = EXIT_IO_FAILED;
  }
  unsigned char initial_binding[CC_SHA256_DIGEST_LENGTH];
  if (code == 0 && !root_binding(manifest_digest, initial_binding))
    code = EXIT_IO_FAILED;
  if (code == 0)
    code = validate_manifest_subset(target_fd, target_identity.st_dev, 0,
                                    &snapshot, manifest_digest, initial_binding,
                                    manifest_resume);
  if (code == 0)
    code = test_pause("AIDEN_REMOVER_TEST_PAUSE_AFTER_SCAN");
  int resume_authorized = 0;
  if (code == 0)
    code = authorization_barrier(authorization_name, manifest_digest,
                                 &resume_authorized);
  if (code == 0)
    code = remove_contents(target_fd, target_identity.st_dev, 0, &snapshot,
                           resume_authorized, manifest_digest, initial_binding);
  free_entries(&snapshot);
  if (code == 0) {
    struct stat held_target;
    struct stat isolated_target;
    if (fstat(target_fd, &held_target) != 0 ||
        fstatat(parent_fd, authorization_name, &isolated_target,
                AT_SYMLINK_NOFOLLOW) != 0 ||
        !same_directory_identity(&target_identity, &held_target) ||
        !same_directory_identity(&held_target, &isolated_target)) {
      code = EXIT_IDENTITY_CHANGED;
    } else if ((code = delete_validated_entry(
                    parent_fd, authorization_name, &isolated_target,
                    same_directory_identity,
                    "AIDEN_REMOVER_TEST_PAUSE_BEFORE_ROOT_CAPTURE",
                    AT_REMOVEDIR)) != 0) {
    } else {
      struct stat replacement;
      if (fstatat(parent_fd, quarantine_name, &replacement,
                  AT_SYMLINK_NOFOLLOW) == 0) {
        code = EXIT_IDENTITY_CHANGED;
      } else if (errno != ENOENT || fsync(parent_fd) != 0) {
        code = EXIT_IO_FAILED;
      }
#ifdef AIDEN_REMOVER_TESTING
      else if (getenv("AIDEN_REMOVER_TEST_FAIL_BEFORE_MANIFEST_UNLINK") !=
               NULL) {
        code = EXIT_IO_FAILED;
      }
#endif
      else
        code = finalize_manifest(
            parent_fd, manifest_name, manifest_finalizing_name,
            manifest_deleting_name, &manifest_identity, manifest_digest);
    }
  }
  close(target_fd);
  if (code != 0 && code != EXIT_IO_FAILED) {
    (void)restore_root(parent_fd, authorization_name, quarantine_name);
  } else if (code == EXIT_IO_FAILED) {
    struct stat remaining_root;
    if (fstatat(parent_fd, authorization_name, &remaining_root,
                AT_SYMLINK_NOFOLLOW) == 0) {
      (void)restore_root(parent_fd, authorization_name, quarantine_name);
    }
  }
  close(parent_fd);
  if (code == EXIT_IDENTITY_CHANGED)
    fputs("identity_changed\n", stderr);
  if (code == EXIT_MUTATION_DETECTED)
    fputs("mutation_detected\n", stderr);
  if (code == EXIT_IO_FAILED)
    fputs("io_failed\n", stderr);
  return code;
}
