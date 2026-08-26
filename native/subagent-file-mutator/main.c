#ifndef __APPLE__
#define _GNU_SOURCE
#endif

#include "../shared/aiden-platform.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef __APPLE__
#include <sys/acl.h>
#endif
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

#define MAX_CONTENT_BYTES 200000
#define MAX_PATH_BYTES 4096
#define MAX_PATH_COMPONENTS 64
#define MAX_REQUEST_ID_BYTES 64
#define MAX_COMMAND_BYTES 275000
#define MAX_NAME_ATTEMPTS 32
#define SHA256_HEX_BYTES 64
#define MAX_PROVENANCE_BYTES 256
#define MAX_LINUX_XATTR_NAMES_BYTES 4096
#define MAX_LINUX_XATTR_VALUE_BYTES 65536
#define STAGING_PREFIX ".aiden-subagent-file-"
#define PROVENANCE_XATTR "com.apple.provenance"
#define UNTRUSTED_READ_FLAGS                                                \
  (O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)

enum Result {
  RESULT_OK = 0,
  RESULT_CONFLICT = 1,
  RESULT_INVALID = 2,
  RESULT_IO = 3,
  RESULT_INDETERMINATE = 4,
};

struct Transaction {
  int active;
  int prepared;
  int committed;
  int expected_absent;
  int parent_fd;
  int expected_fd;
  char request_id[MAX_REQUEST_ID_BYTES + 1];
  char leaf[NAME_MAX + 1];
  char expected_digest[SHA256_HEX_BYTES + 1];
  unsigned char expected_provenance[MAX_PROVENANCE_BYTES];
  size_t expected_provenance_length;
  int expected_provenance_present;
  unsigned char relative_path[MAX_PATH_BYTES + 1];
  size_t path_length;
  unsigned char *contents;
  size_t content_length;
  unsigned char *inspection_contents;
  size_t inspection_length;
  char content_digest[SHA256_HEX_BYTES + 1];
  struct stat expected_identity;
  char recovery_name[NAME_MAX + 1];
  struct stat recovery_identity;
  int recovery_unlinked;
  int commit_parent_synced;
};

static int same_timestamp(struct timespec left, struct timespec right) {
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

static int exclusive_regular(const struct stat *identity) {
  return S_ISREG(identity->st_mode) && identity->st_nlink == 1;
}

static int same_identity(const struct stat *left, const struct stat *right) {
#ifdef __APPLE__
  return exclusive_regular(left) && exclusive_regular(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_uid == right->st_uid &&
         left->st_gid == right->st_gid && left->st_flags == right->st_flags &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtimespec, right->st_mtimespec) &&
         same_timestamp(left->st_ctimespec, right->st_ctimespec) &&
         same_timestamp(left->st_birthtimespec, right->st_birthtimespec);
#else
  return exclusive_regular(left) && exclusive_regular(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_uid == right->st_uid &&
         left->st_gid == right->st_gid && left->st_size == right->st_size &&
         same_timestamp(left->st_mtim, right->st_mtim) &&
         same_timestamp(left->st_ctim, right->st_ctim);
#endif
}

/* renameatx_np may update ctime while preserving the underlying inode. */
static int same_renamed_identity(const struct stat *left,
                                 const struct stat *right) {
#ifdef __APPLE__
  return exclusive_regular(left) && exclusive_regular(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_uid == right->st_uid &&
         left->st_gid == right->st_gid && left->st_flags == right->st_flags &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtimespec, right->st_mtimespec) &&
         same_timestamp(left->st_birthtimespec, right->st_birthtimespec);
#else
  return exclusive_regular(left) && exclusive_regular(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_uid == right->st_uid &&
         left->st_gid == right->st_gid && left->st_size == right->st_size &&
         same_timestamp(left->st_mtim, right->st_mtim);
#endif
}

static int same_file_object(const struct stat *left,
                            const struct stat *right) {
  return exclusive_regular(left) && exclusive_regular(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int same_preserved_metadata(const struct stat *left,
                                   const struct stat *right) {
#ifdef __APPLE__
  return (left->st_mode & (S_IFMT | 07777)) ==
             (right->st_mode & (S_IFMT | 07777)) &&
         left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
         left->st_flags == right->st_flags;
#else
  return (left->st_mode & (S_IFMT | 07777)) ==
             (right->st_mode & (S_IFMT | 07777)) &&
         left->st_uid == right->st_uid && left->st_gid == right->st_gid;
#endif
}

static int same_renamed_entry(const struct stat *left,
                              const struct stat *right) {
#ifdef __APPLE__
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_nlink == right->st_nlink &&
         left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
         left->st_flags == right->st_flags &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtimespec, right->st_mtimespec) &&
         same_timestamp(left->st_birthtimespec, right->st_birthtimespec);
#else
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_mode == right->st_mode && left->st_nlink == right->st_nlink &&
         left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtim, right->st_mtim);
#endif
}

/*
 * macOS adds com.apple.provenance to ordinary workspace and temporary files.
 * It is the sole supported xattr and is copied byte-for-byte, bounded above.
 * Unknown xattrs, extended ACL entries, and BSD flags fail closed.
 */
static int read_supported_xattrs(int descriptor,
                                 unsigned char value[MAX_PROVENANCE_BYTES],
                                 size_t *value_length, int *present) {
  *value_length = 0;
  *present = 0;
#ifdef __APPLE__
  ssize_t names_length = flistxattr(descriptor, NULL, 0, 0);
#else
  ssize_t names_length = flistxattr(descriptor, NULL, 0);
#endif
  if (names_length < 0)
    return -1;
  if (names_length == 0)
    return 1;
  if (names_length > 4096)
    return 0;
  char *names = malloc((size_t)names_length);
  if (names == NULL)
    return -1;
#ifdef __APPLE__
  ssize_t read_names = flistxattr(descriptor, names, (size_t)names_length, 0);
#else
  ssize_t read_names = flistxattr(descriptor, names, (size_t)names_length);
#endif
  int valid = read_names == names_length;
  size_t offset = 0;
  int count = 0;
  while (valid && offset < (size_t)names_length) {
    size_t remaining = (size_t)names_length - offset;
    size_t name_length = strnlen(names + offset, remaining);
    if (name_length == remaining
#ifdef __APPLE__
        || strcmp(names + offset, PROVENANCE_XATTR) != 0
#endif
    ) {
      valid = 0;
      break;
    }
    count += 1;
    offset += name_length + 1;
  }
  free(names);
  if (!valid
#ifdef __APPLE__
      || count != 1
#endif
  )
    return 0;
#ifndef __APPLE__
  /* Linux xattrs are copied and compared in full during staging. The
   * provenance fields are a macOS wire detail and remain absent here. */
  (void)value;
  (void)count;
  return 1;
#else
  ssize_t length =
      fgetxattr(descriptor, PROVENANCE_XATTR, NULL, 0, 0, 0);
  if (length < 0)
    return -1;
  if (length > MAX_PROVENANCE_BYTES)
    return 0;
  ssize_t read_value = fgetxattr(descriptor, PROVENANCE_XATTR, value,
                                 (size_t)length, 0, 0);
  if (read_value != length)
    return -1;
  *value_length = (size_t)length;
  *present = 1;
  return 1;
#endif
}

static int supported_metadata(int descriptor, const struct stat *identity) {
#ifdef __APPLE__
  if (identity->st_flags != 0)
    return 0;
  unsigned char provenance[MAX_PROVENANCE_BYTES];
  size_t provenance_length;
  int provenance_present;
  int xattrs = read_supported_xattrs(descriptor, provenance,
                                     &provenance_length, &provenance_present);
  if (xattrs != 1)
    return xattrs;
  acl_t access_control = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED);
  if (access_control == NULL)
    return errno == ENOENT ? 1 : -1;
  acl_entry_t entry;
  errno = 0;
  int entry_result = acl_get_entry(access_control, ACL_FIRST_ENTRY, &entry);
  int entry_error = errno;
  acl_free(access_control);
  if (entry_result == 0)
    return 0;
  return entry_error == EINVAL ? 1 : -1;
#else
  (void)identity;
  unsigned char provenance[MAX_PROVENANCE_BYTES];
  size_t provenance_length;
  int provenance_present;
  return read_supported_xattrs(descriptor, provenance, &provenance_length,
                               &provenance_present);
#endif
}

#ifndef __APPLE__
static int linux_xattr_names(int descriptor, char **names,
                             size_t *names_length) {
  ssize_t length = flistxattr(descriptor, NULL, 0);
  if (length < 0)
    return -1;
  if (length > MAX_LINUX_XATTR_NAMES_BYTES)
    return 0;
  char *result = malloc(length == 0 ? 1 : (size_t)length);
  if (result == NULL)
    return -1;
  if (length > 0 && flistxattr(descriptor, result, (size_t)length) != length) {
    free(result);
    return -1;
  }
  *names = result;
  *names_length = (size_t)length;
  return 1;
}

static int linux_xattr_value(int descriptor, const char *name,
                             unsigned char **value, size_t *value_length) {
  ssize_t length = fgetxattr(descriptor, name, NULL, 0);
  if (length < 0)
    return errno == ENODATA ? 0 : -1;
  if (length > MAX_LINUX_XATTR_VALUE_BYTES)
    return -2;
  unsigned char *result = malloc(length == 0 ? 1 : (size_t)length);
  if (result == NULL)
    return -1;
  if (length > 0 &&
      fgetxattr(descriptor, name, result, (size_t)length) != length) {
    free(result);
    return -1;
  }
  *value = result;
  *value_length = (size_t)length;
  return 1;
}

static int linux_named_xattr_matches(int left, int right, const char *name) {
  unsigned char *left_value = NULL;
  unsigned char *right_value = NULL;
  size_t left_length = 0;
  size_t right_length = 0;
  int left_result = linux_xattr_value(left, name, &left_value, &left_length);
  int right_result =
      linux_xattr_value(right, name, &right_value, &right_length);
  int matches = left_result == 1 && right_result == 1 &&
                left_length == right_length &&
                memcmp(left_value, right_value, left_length) == 0;
  free(left_value);
  free(right_value);
  if (left_result < 0 || right_result < 0)
    return left_result == -2 || right_result == -2 ? 0 : -1;
  return matches ? 1 : 0;
}

static int linux_xattrs_match(int left, int right) {
  char *left_names = NULL;
  char *right_names = NULL;
  size_t left_length = 0;
  size_t right_length = 0;
  int left_result = linux_xattr_names(left, &left_names, &left_length);
  int right_result = linux_xattr_names(right, &right_names, &right_length);
  if (left_result != 1 || right_result != 1) {
    free(left_names);
    free(right_names);
    return left_result == 0 || right_result == 0 ? 0 : -1;
  }
  size_t offset = 0;
  int matches = 1;
  size_t left_count = 0;
  while (matches && offset < left_length) {
    size_t name_length = strnlen(left_names + offset, left_length - offset);
    if (name_length == left_length - offset ||
        linux_named_xattr_matches(left, right, left_names + offset) != 1) {
      matches = 0;
      break;
    }
    left_count += 1;
    offset += name_length + 1;
  }
  offset = 0;
  size_t right_count = 0;
  while (matches && offset < right_length) {
    size_t name_length = strnlen(right_names + offset, right_length - offset);
    if (name_length == right_length - offset) {
      matches = 0;
      break;
    }
    right_count += 1;
    offset += name_length + 1;
  }
  free(left_names);
  free(right_names);
  return matches && left_count == right_count ? 1 : 0;
}

static int linux_copy_xattrs(int source, int destination) {
  char *source_names = NULL;
  size_t source_names_length = 0;
  int source_result =
      linux_xattr_names(source, &source_names, &source_names_length);
  if (source_result != 1) {
    free(source_names);
    return source_result;
  }
  size_t offset = 0;
  while (offset < source_names_length) {
    const char *name = source_names + offset;
    size_t name_length = strnlen(name, source_names_length - offset);
    if (name_length == source_names_length - offset) {
      free(source_names);
      return 0;
    }
    int matches = linux_named_xattr_matches(source, destination, name);
    if (matches < 0) {
      free(source_names);
      return -1;
    }
    if (matches == 0) {
      unsigned char *value = NULL;
      size_t value_length = 0;
      int value_result =
          linux_xattr_value(source, name, &value, &value_length);
      if (value_result != 1 ||
          fsetxattr(destination, name, value, value_length, 0) != 0) {
        free(value);
        free(source_names);
        return value_result == -2 ? 0 : -1;
      }
      free(value);
    }
    offset += name_length + 1;
  }

  char *destination_names = NULL;
  size_t destination_names_length = 0;
  int destination_result = linux_xattr_names(
      destination, &destination_names, &destination_names_length);
  if (destination_result != 1) {
    free(source_names);
    free(destination_names);
    return destination_result;
  }
  offset = 0;
  while (offset < destination_names_length) {
    const char *name = destination_names + offset;
    size_t name_length = strnlen(name, destination_names_length - offset);
    if (name_length == destination_names_length - offset) {
      free(source_names);
      free(destination_names);
      return 0;
    }
    unsigned char *ignored = NULL;
    size_t ignored_length = 0;
    int exists = linux_xattr_value(source, name, &ignored, &ignored_length);
    free(ignored);
    if (exists == 0 && fremovexattr(destination, name) != 0 &&
        errno != ENODATA) {
      free(source_names);
      free(destination_names);
      return -1;
    }
    if (exists < 0) {
      free(source_names);
      free(destination_names);
      return exists == -2 ? 0 : -1;
    }
    offset += name_length + 1;
  }
  free(source_names);
  free(destination_names);
  return linux_xattrs_match(source, destination);
}
#endif

static int copy_supported_xattrs(int source, int destination) {
#ifndef __APPLE__
  return linux_copy_xattrs(source, destination);
#else
  unsigned char source_value[MAX_PROVENANCE_BYTES];
  unsigned char destination_value[MAX_PROVENANCE_BYTES];
  size_t source_length;
  size_t destination_length;
  int source_present;
  int destination_present;
  int source_result = read_supported_xattrs(
      source, source_value, &source_length, &source_present);
  int destination_result = read_supported_xattrs(
      destination, destination_value, &destination_length,
      &destination_present);
  if (source_result != 1 || destination_result != 1)
    return source_result == 0 || destination_result == 0 ? 0 : -1;
  if (source_present) {
    if (fsetxattr(destination, PROVENANCE_XATTR, source_value, source_length, 0,
                  0) != 0)
      return -1;
  } else if (destination_present &&
             fremovexattr(destination, PROVENANCE_XATTR, 0) != 0) {
    return -1;
  }
  return 1;
#endif
}

static int matching_supported_xattrs(int left, int right) {
#ifndef __APPLE__
  return linux_xattrs_match(left, right);
#else
  unsigned char left_value[MAX_PROVENANCE_BYTES];
  unsigned char right_value[MAX_PROVENANCE_BYTES];
  size_t left_length;
  size_t right_length;
  int left_present;
  int right_present;
  int left_result = read_supported_xattrs(left, left_value, &left_length,
                                          &left_present);
  int right_result = read_supported_xattrs(right, right_value, &right_length,
                                           &right_present);
  if (left_result != 1 || right_result != 1)
    return left_result == 0 || right_result == 0 ? 0 : -1;
  return left_present == right_present && left_length == right_length &&
                 (!left_present ||
                  memcmp(left_value, right_value, left_length) == 0)
             ? 1
             : 0;
#endif
}

static int matches_expected_provenance(const struct Transaction *transaction,
                                       int descriptor) {
  // Linux intentionally reports the macOS provenance wire field as absent.
  // Initialize the buffer so GCC can prove the short-circuited memcmp is safe
  // under -O2 -Wmaybe-uninitialized as well as Clang.
  unsigned char value[MAX_PROVENANCE_BYTES] = {0};
  size_t length;
  int present;
  if (read_supported_xattrs(descriptor, value, &length, &present) != 1)
    return 0;
  return present == transaction->expected_provenance_present &&
         length == transaction->expected_provenance_length &&
         (!present ||
          memcmp(value, transaction->expected_provenance, length) == 0);
}

static int valid_hex_digest(const char *value) {
  if (strlen(value) != SHA256_HEX_BYTES)
    return 0;
  for (size_t index = 0; index < SHA256_HEX_BYTES; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f')))
      return 0;
  }
  return 1;
}

static void encode_digest(const unsigned char digest[CC_SHA256_DIGEST_LENGTH],
                          char output[SHA256_HEX_BYTES + 1]) {
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  output[SHA256_HEX_BYTES] = '\0';
}

static int sha256_bytes(const unsigned char *bytes, size_t length,
                        char output[SHA256_HEX_BYTES + 1]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256(bytes, (CC_LONG)length, digest) == NULL)
    return -1;
  encode_digest(digest, output);
  return 0;
}

static int sha256_descriptor(int descriptor, size_t maximum,
                             char output[SHA256_HEX_BYTES + 1],
                             struct stat *verified_identity) {
  struct stat before;
  struct stat after;
  if (fstat(descriptor, &before) != 0 || !exclusive_regular(&before) ||
      before.st_size < 0 || (uint64_t)before.st_size > maximum)
    return -1;
  CC_SHA256_CTX context;
  if (CC_SHA256_Init(&context) != 1)
    return -1;
  unsigned char buffer[8192];
  off_t offset = 0;
  while (offset < before.st_size) {
    size_t remaining = (size_t)(before.st_size - offset);
    size_t requested = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    ssize_t count;
    do {
      count = pread(descriptor, buffer, requested, offset);
    } while (count < 0 && errno == EINTR);
    if (count <= 0 || CC_SHA256_Update(&context, buffer, (CC_LONG)count) != 1)
      return -1;
    offset += count;
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256_Final(digest, &context) != 1 || fstat(descriptor, &after) != 0 ||
      !same_identity(&before, &after))
    return -1;
  encode_digest(digest, output);
  if (verified_identity != NULL)
    *verified_identity = after;
  return 0;
}

static int base64_value(unsigned char value) {
  if (value >= 'A' && value <= 'Z')
    return value - 'A';
  if (value >= 'a' && value <= 'z')
    return value - 'a' + 26;
  if (value >= '0' && value <= '9')
    return value - '0' + 52;
  if (value == '+')
    return 62;
  if (value == '/')
    return 63;
  return -1;
}

static int decode_base64(const char *encoded, size_t maximum,
                         unsigned char **bytes, size_t *length) {
  if (strcmp(encoded, "-") == 0) {
    *bytes = calloc(1, 1);
    *length = 0;
    return *bytes == NULL ? -1 : 0;
  }
  size_t encoded_length = strlen(encoded);
  if (encoded_length == 0 || encoded_length % 4 != 0 ||
      encoded_length > ((maximum + 2) / 3) * 4)
    return -1;
  size_t padding = 0;
  if (encoded[encoded_length - 1] == '=')
    padding += 1;
  if (encoded_length > 1 && encoded[encoded_length - 2] == '=')
    padding += 1;
  size_t decoded_length = encoded_length / 4 * 3 - padding;
  if (decoded_length > maximum)
    return -1;
  unsigned char *result = malloc(decoded_length + 1);
  if (result == NULL)
    return -1;
  size_t output = 0;
  for (size_t index = 0; index < encoded_length; index += 4) {
    int first = base64_value((unsigned char)encoded[index]);
    int second = base64_value((unsigned char)encoded[index + 1]);
    int third = encoded[index + 2] == '='
                    ? 0
                    : base64_value((unsigned char)encoded[index + 2]);
    int fourth = encoded[index + 3] == '='
                     ? 0
                     : base64_value((unsigned char)encoded[index + 3]);
    int final_group = index + 4 == encoded_length;
    if (first < 0 || second < 0 || third < 0 || fourth < 0 ||
        (!final_group &&
         (encoded[index + 2] == '=' || encoded[index + 3] == '=')) ||
        (encoded[index + 2] == '=' && encoded[index + 3] != '=')) {
      free(result);
      return -1;
    }
    uint32_t value = ((uint32_t)first << 18) | ((uint32_t)second << 12) |
                     ((uint32_t)third << 6) | (uint32_t)fourth;
    if (output < decoded_length)
      result[output++] = (unsigned char)(value >> 16);
    if (output < decoded_length)
      result[output++] = (unsigned char)(value >> 8);
    if (output < decoded_length)
      result[output++] = (unsigned char)value;
  }
  result[decoded_length] = '\0';
  *bytes = result;
  *length = decoded_length;
  return 0;
}

static int valid_request_id(const char *value) {
  size_t length = strlen(value);
  if (length == 0 || length > MAX_REQUEST_ID_BYTES)
    return 0;
  for (size_t index = 0; index < length; index += 1) {
    char character = value[index];
    if (!((character >= 'A' && character <= 'Z') ||
          (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '-' ||
          character == '_'))
      return 0;
  }
  return 1;
}

static void clear_transaction(struct Transaction *transaction) {
  if (transaction->parent_fd >= 0)
    close(transaction->parent_fd);
  if (transaction->expected_fd >= 0)
    close(transaction->expected_fd);
  free(transaction->contents);
  free(transaction->inspection_contents);
  memset(transaction, 0, sizeof(*transaction));
  transaction->parent_fd = -1;
  transaction->expected_fd = -1;
}

static int open_parent(int root_fd, unsigned char *relative_path,
                       size_t path_length, int *parent_fd,
                       char leaf[NAME_MAX + 1]) {
  if (path_length == 0 || path_length > MAX_PATH_BYTES ||
      relative_path[0] == '/' || memchr(relative_path, '\0', path_length) != NULL)
    return RESULT_INVALID;
  size_t validation_start = 0;
  size_t validation_components = 0;
  for (size_t index = 0; index <= path_length; index += 1) {
    if (index != path_length && relative_path[index] != '/')
      continue;
    size_t component_length = index - validation_start;
    validation_components += 1;
    if (component_length == 0 || component_length > NAME_MAX ||
        validation_components > MAX_PATH_COMPONENTS ||
        (component_length == 1 && relative_path[validation_start] == '.') ||
        (component_length == 2 && relative_path[validation_start] == '.' &&
         relative_path[validation_start + 1] == '.'))
      return RESULT_INVALID;
    char component[NAME_MAX + 1];
    memcpy(component, relative_path + validation_start, component_length);
    component[component_length] = '\0';
    if (strncmp(component, STAGING_PREFIX, strlen(STAGING_PREFIX)) == 0)
      return RESULT_INVALID;
    validation_start = index + 1;
  }

  int current = openat(root_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0)
    return RESULT_IO;
  size_t component_start = 0;
  size_t components = 0;
  for (size_t index = 0; index <= path_length; index += 1) {
    if (index != path_length && relative_path[index] != '/')
      continue;
    size_t component_length = index - component_start;
    components += 1;
    if (component_length == 0 || component_length > NAME_MAX ||
        components > MAX_PATH_COMPONENTS ||
        (component_length == 1 && relative_path[component_start] == '.') ||
        (component_length == 2 && relative_path[component_start] == '.' &&
         relative_path[component_start + 1] == '.')) {
      close(current);
      return RESULT_INVALID;
    }
    char component[NAME_MAX + 1];
    memcpy(component, relative_path + component_start, component_length);
    component[component_length] = '\0';
    if (strncmp(component, STAGING_PREFIX, strlen(STAGING_PREFIX)) == 0) {
      close(current);
      return RESULT_INVALID;
    }
    if (index == path_length) {
      memcpy(leaf, component, component_length + 1);
      *parent_fd = current;
      return RESULT_OK;
    }
    int next = openat(current, component,
                      O_RDONLY | O_DIRECTORY | O_NONBLOCK | O_NOFOLLOW |
                          O_CLOEXEC);
    struct stat identity;
    if (next < 0 || fstat(next, &identity) != 0 || !S_ISDIR(identity.st_mode)) {
      if (next >= 0)
        close(next);
      close(current);
      return errno == ELOOP || errno == ENOTDIR || errno == ENOENT
                 ? RESULT_CONFLICT
                 : RESULT_IO;
    }
    close(current);
    current = next;
    component_start = index + 1;
  }
  close(current);
  return RESULT_INVALID;
}

static int write_all(int descriptor, const unsigned char *bytes,
                     size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(descriptor, bytes + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR)
        continue;
      return -1;
    }
    offset += (size_t)written;
  }
  return 0;
}

static int read_all_at(int descriptor, unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = pread(descriptor, bytes + offset, length - offset,
                          (off_t)offset);
    if (count < 0) {
      if (errno == EINTR)
        continue;
      return -1;
    }
    if (count == 0)
      return -1;
    offset += (size_t)count;
  }
  return 0;
}

static void print_base64(const unsigned char *bytes, size_t length) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (length == 0) {
    putchar('-');
    return;
  }
  for (size_t index = 0; index < length; index += 3) {
    size_t remaining = length - index;
    uint32_t value = (uint32_t)bytes[index] << 16;
    if (remaining > 1)
      value |= (uint32_t)bytes[index + 1] << 8;
    if (remaining > 2)
      value |= bytes[index + 2];
    putchar(alphabet[(value >> 18) & 0x3f]);
    putchar(alphabet[(value >> 12) & 0x3f]);
    putchar(remaining > 1 ? alphabet[(value >> 6) & 0x3f] : '=');
    putchar(remaining > 2 ? alphabet[value & 0x3f] : '=');
  }
}

static int revalidate_root(int root_fd, const char *root_path) {
  int current_root =
      open(root_path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat retained;
  struct stat current;
  int matches = current_root >= 0 && fstat(root_fd, &retained) == 0 &&
                fstat(current_root, &current) == 0 &&
                S_ISDIR(retained.st_mode) && S_ISDIR(current.st_mode) &&
                retained.st_dev == current.st_dev &&
                retained.st_ino == current.st_ino;
  if (current_root >= 0)
    close(current_root);
  return matches ? RESULT_OK : RESULT_CONFLICT;
}

static int revalidate_parent(int root_fd, const char *root_path,
                             const struct Transaction *transaction) {
  int root_result = revalidate_root(root_fd, root_path);
  if (root_result != RESULT_OK)
    return root_result;
  int current_parent = -1;
  char current_leaf[NAME_MAX + 1];
  int result = open_parent(root_fd, (unsigned char *)transaction->relative_path,
                           transaction->path_length, &current_parent,
                           current_leaf);
  if (result != RESULT_OK)
    return result;
  struct stat retained;
  struct stat current;
  int matches = strcmp(current_leaf, transaction->leaf) == 0 &&
                fstat(transaction->parent_fd, &retained) == 0 &&
                fstat(current_parent, &current) == 0 &&
                S_ISDIR(retained.st_mode) && S_ISDIR(current.st_mode) &&
                retained.st_dev == current.st_dev &&
                retained.st_ino == current.st_ino;
  close(current_parent);
  return matches ? RESULT_OK : RESULT_CONFLICT;
}

static void random_uuid(char output[37]) {
  static const char hex[] = "0123456789abcdef";
  uint8_t bytes[16];
  arc4random_buf(bytes, sizeof(bytes));
  bytes[6] = (uint8_t)((bytes[6] & 0x0f) | 0x40);
  bytes[8] = (uint8_t)((bytes[8] & 0x3f) | 0x80);
  size_t byte_index = 0;
  size_t output_index = 0;
  for (; byte_index < sizeof(bytes); byte_index += 1) {
    if (output_index == 8 || output_index == 13 || output_index == 18 ||
        output_index == 23)
      output[output_index++] = '-';
    output[output_index++] = hex[bytes[byte_index] >> 4];
    output[output_index++] = hex[bytes[byte_index] & 0x0f];
  }
  output[36] = '\0';
}

static int create_stage(int parent_fd, const char *request_id,
                        char name[NAME_MAX + 1]) {
  for (int attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    char uuid[37];
    random_uuid(uuid);
    int length = snprintf(name, NAME_MAX + 1, "%s%s-%s.tmp", STAGING_PREFIX,
                          request_id, uuid);
    if (length <= 0 || length > NAME_MAX)
      return -1;
    int descriptor = openat(parent_fd, name,
                            O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                            0600);
    if (descriptor >= 0)
      return descriptor;
    if (errno != EEXIST)
      return -1;
  }
  return -1;
}

static int verify_named_file(int parent_fd, const char *name,
                             const struct stat *expected,
                             const char *expected_digest,
                             int renamed_identity) {
  int descriptor = openat(parent_fd, name, UNTRUSTED_READ_FLAGS);
  if (descriptor < 0)
    return -1;
  struct stat identity;
  char digest[SHA256_HEX_BYTES + 1];
  int result = sha256_descriptor(descriptor, MAX_CONTENT_BYTES, digest, &identity);
  close(descriptor);
  if (result != 0 || strcmp(digest, expected_digest) != 0)
    return -1;
  return renamed_identity ? same_renamed_identity(expected, &identity)
                          : same_identity(expected, &identity);
}

static int named_xattrs_match(int parent_fd, const char *name,
                              int expected_descriptor) {
  int descriptor = openat(parent_fd, name, UNTRUSTED_READ_FLAGS);
  if (descriptor < 0)
    return 0;
  struct stat expected_identity;
  struct stat named_identity;
  int matches = fstat(expected_descriptor, &expected_identity) == 0 &&
                        fstat(descriptor, &named_identity) == 0 &&
                        supported_metadata(expected_descriptor,
                                           &expected_identity) == 1 &&
                        supported_metadata(descriptor, &named_identity) == 1
                    ? matching_supported_xattrs(expected_descriptor, descriptor)
                    : 0;
  close(descriptor);
  return matches == 1;
}

#ifdef AIDEN_SUBAGENT_FILE_MUTATOR_TESTING
static int test_pause(const char *environment_name) {
  const char *marker = getenv(environment_name);
  if (marker == NULL || marker[0] == '\0')
    return 0;
  int marker_fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (marker_fd < 0)
    return -1;
  if (fsync(marker_fd) != 0 || close(marker_fd) != 0)
    return -1;
  char continuation[PATH_MAX];
  int length = snprintf(continuation, sizeof(continuation), "%s.continue", marker);
  if (length < 0 || (size_t)length >= sizeof(continuation))
    return -1;
  for (int attempt = 0; attempt < 3000; attempt += 1) {
    if (access(continuation, F_OK) == 0)
      return 0;
    if (errno != ENOENT)
      return -1;
    usleep(10000);
  }
  return -1;
}
#else
static int test_pause(const char *environment_name) {
  (void)environment_name;
  return 0;
}
#endif

#ifdef AIDEN_SUBAGENT_FILE_MUTATOR_TESTING
static int test_fail_fsync_once(const char *environment_name) {
  const char *marker = getenv(environment_name);
  if (marker == NULL || marker[0] == '\0' || access(marker, F_OK) == 0)
    return 0;
  int descriptor =
      open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (descriptor < 0)
    return -1;
  int synced = fsync(descriptor);
  int closed = close(descriptor);
  return synced == 0 && closed == 0 ? 1 : -1;
}

static int test_fail_finalize_fsync_once(void) {
  return test_fail_fsync_once(
      "AIDEN_SUBAGENT_FILE_MUTATOR_TEST_FAIL_FINALIZE_FSYNC_ONCE");
}

static int test_fail_commit_fsync_once(void) {
  return test_fail_fsync_once(
      "AIDEN_SUBAGENT_FILE_MUTATOR_TEST_FAIL_COMMIT_FSYNC_ONCE");
}
#else
static int test_fail_finalize_fsync_once(void) { return 0; }
static int test_fail_commit_fsync_once(void) { return 0; }
#endif

static int prepare_transaction(int root_fd, const char *root_path,
                               struct Transaction *transaction,
                               const char *request_id, const char *expected,
                               const char *encoded_path,
                               const char *encoded_contents) {
  if (transaction->active)
    return RESULT_CONFLICT;
  int root_result = revalidate_root(root_fd, root_path);
  if (root_result != RESULT_OK)
    return root_result;
  if (!valid_request_id(request_id) ||
      !(strcmp(expected, "absent") == 0 || valid_hex_digest(expected)))
    return RESULT_INVALID;
  unsigned char *relative_path = NULL;
  unsigned char *contents = NULL;
  size_t path_length = 0;
  size_t content_length = 0;
  if (decode_base64(encoded_path, MAX_PATH_BYTES, &relative_path, &path_length) !=
          0 ||
      decode_base64(encoded_contents, MAX_CONTENT_BYTES, &contents,
                    &content_length) != 0) {
    free(relative_path);
    free(contents);
    return RESULT_INVALID;
  }
  struct Transaction candidate;
  memset(&candidate, 0, sizeof(candidate));
  candidate.parent_fd = -1;
  candidate.expected_fd = -1;
  int path_result = open_parent(root_fd, relative_path, path_length,
                                &candidate.parent_fd, candidate.leaf);
  if (path_result == RESULT_OK) {
    memcpy(candidate.relative_path, relative_path, path_length);
    candidate.relative_path[path_length] = '\0';
    candidate.path_length = path_length;
  }
  free(relative_path);
  if (path_result != RESULT_OK) {
    free(contents);
    return path_result;
  }
  candidate.expected_absent = strcmp(expected, "absent") == 0;
  candidate.expected_fd =
      openat(candidate.parent_fd, candidate.leaf, UNTRUSTED_READ_FLAGS);
  if (candidate.expected_absent) {
    if (candidate.expected_fd >= 0 || errno != ENOENT) {
      clear_transaction(&candidate);
      free(contents);
      return RESULT_CONFLICT;
    }
  } else {
    if (candidate.expected_fd < 0) {
      clear_transaction(&candidate);
      free(contents);
      return RESULT_CONFLICT;
    }
    char current_digest[SHA256_HEX_BYTES + 1];
    if (sha256_descriptor(candidate.expected_fd, MAX_CONTENT_BYTES,
                          current_digest, &candidate.expected_identity) != 0 ||
        strcmp(current_digest, expected) != 0) {
      clear_transaction(&candidate);
      free(contents);
      return RESULT_CONFLICT;
    }
    int metadata =
        supported_metadata(candidate.expected_fd, &candidate.expected_identity);
    if (metadata != 1) {
      clear_transaction(&candidate);
      free(contents);
      return metadata == 0 ? RESULT_CONFLICT : RESULT_IO;
    }
    if (read_supported_xattrs(
            candidate.expected_fd, candidate.expected_provenance,
            &candidate.expected_provenance_length,
            &candidate.expected_provenance_present) != 1) {
      clear_transaction(&candidate);
      free(contents);
      return RESULT_CONFLICT;
    }
    memcpy(candidate.expected_digest, expected, SHA256_HEX_BYTES + 1);
  }
  if (sha256_bytes(contents, content_length, candidate.content_digest) != 0) {
    clear_transaction(&candidate);
    free(contents);
    return RESULT_IO;
  }
  candidate.active = 1;
  candidate.prepared = 1;
  candidate.contents = contents;
  candidate.content_length = content_length;
  memcpy(candidate.request_id, request_id, strlen(request_id) + 1);
  *transaction = candidate;
  return RESULT_OK;
}

static int inspect_transaction(int root_fd, const char *root_path,
                               struct Transaction *transaction,
                               const char *request_id,
                               const char *encoded_path) {
  if (transaction->active)
    return RESULT_CONFLICT;
  int root_result = revalidate_root(root_fd, root_path);
  if (root_result != RESULT_OK)
    return root_result;
  if (!valid_request_id(request_id))
    return RESULT_INVALID;
  unsigned char *relative_path = NULL;
  size_t path_length = 0;
  if (decode_base64(encoded_path, MAX_PATH_BYTES, &relative_path,
                    &path_length) != 0)
    return RESULT_INVALID;
  struct Transaction candidate;
  memset(&candidate, 0, sizeof(candidate));
  candidate.parent_fd = -1;
  candidate.expected_fd = -1;
  int path_result = open_parent(root_fd, relative_path, path_length,
                                &candidate.parent_fd, candidate.leaf);
  if (path_result == RESULT_OK) {
    memcpy(candidate.relative_path, relative_path, path_length);
    candidate.relative_path[path_length] = '\0';
    candidate.path_length = path_length;
  }
  free(relative_path);
  if (path_result != RESULT_OK)
    return path_result;
  candidate.expected_fd =
      openat(candidate.parent_fd, candidate.leaf, UNTRUSTED_READ_FLAGS);
  if (candidate.expected_fd < 0) {
    if (errno != ENOENT) {
      clear_transaction(&candidate);
      return RESULT_CONFLICT;
    }
    candidate.expected_absent = 1;
  } else {
    if (sha256_descriptor(candidate.expected_fd, MAX_CONTENT_BYTES,
                          candidate.expected_digest,
                          &candidate.expected_identity) != 0) {
      clear_transaction(&candidate);
      return RESULT_CONFLICT;
    }
    int metadata =
        supported_metadata(candidate.expected_fd, &candidate.expected_identity);
    if (metadata != 1) {
      clear_transaction(&candidate);
      return metadata == 0 ? RESULT_CONFLICT : RESULT_IO;
    }
    if (read_supported_xattrs(
            candidate.expected_fd, candidate.expected_provenance,
            &candidate.expected_provenance_length,
            &candidate.expected_provenance_present) != 1) {
      clear_transaction(&candidate);
      return RESULT_CONFLICT;
    }
    candidate.inspection_length = (size_t)candidate.expected_identity.st_size;
    candidate.inspection_contents =
        calloc(candidate.inspection_length + 1, sizeof(unsigned char));
    struct stat after_read;
    char read_digest[SHA256_HEX_BYTES + 1];
    if (candidate.inspection_contents == NULL ||
        read_all_at(candidate.expected_fd, candidate.inspection_contents,
                    candidate.inspection_length) != 0 ||
        fstat(candidate.expected_fd, &after_read) != 0 ||
        !same_identity(&candidate.expected_identity, &after_read) ||
        sha256_bytes(candidate.inspection_contents, candidate.inspection_length,
                     read_digest) != 0 ||
        strcmp(read_digest, candidate.expected_digest) != 0) {
      clear_transaction(&candidate);
      return RESULT_CONFLICT;
    }
  }
  candidate.active = 1;
  memcpy(candidate.request_id, request_id, strlen(request_id) + 1);
  *transaction = candidate;
  return RESULT_OK;
}

static int prepare_inspected_transaction(
    int root_fd, const char *root_path, struct Transaction *transaction,
    const char *request_id, const char *expected,
    const char *encoded_contents) {
  if (!transaction->active || transaction->prepared || transaction->committed ||
      strcmp(transaction->request_id, request_id) != 0 ||
      !(strcmp(expected, "absent") == 0 || valid_hex_digest(expected)))
    return RESULT_INVALID;
  if ((transaction->expected_absent && strcmp(expected, "absent") != 0) ||
      (!transaction->expected_absent &&
       strcmp(expected, transaction->expected_digest) != 0))
    return RESULT_CONFLICT;
  int parent_result = revalidate_parent(root_fd, root_path, transaction);
  if (parent_result != RESULT_OK)
    return parent_result;
  if (transaction->expected_absent) {
    struct stat unexpected;
    if (fstatat(transaction->parent_fd, transaction->leaf, &unexpected,
                AT_SYMLINK_NOFOLLOW) == 0 ||
        errno != ENOENT)
      return RESULT_CONFLICT;
  } else {
    struct stat retained;
    struct stat current_identity;
    int current =
        openat(transaction->parent_fd, transaction->leaf, UNTRUSTED_READ_FLAGS);
    char retained_digest[SHA256_HEX_BYTES + 1];
    int valid =
        current >= 0 &&
        sha256_descriptor(transaction->expected_fd, MAX_CONTENT_BYTES,
                          retained_digest, &retained) == 0 &&
        fstat(current, &current_identity) == 0 &&
        same_identity(&transaction->expected_identity, &retained) &&
        same_identity(&transaction->expected_identity, &current_identity) &&
        strcmp(retained_digest, transaction->expected_digest) == 0;
    if (current >= 0)
      close(current);
    if (!valid)
      return RESULT_CONFLICT;
  }
  unsigned char *contents = NULL;
  size_t content_length = 0;
  if (decode_base64(encoded_contents, MAX_CONTENT_BYTES, &contents,
                    &content_length) != 0)
    return RESULT_INVALID;
  char content_digest[SHA256_HEX_BYTES + 1];
  if (sha256_bytes(contents, content_length, content_digest) != 0) {
    free(contents);
    return RESULT_IO;
  }
  free(transaction->inspection_contents);
  transaction->inspection_contents = NULL;
  transaction->inspection_length = 0;
  transaction->contents = contents;
  transaction->content_length = content_length;
  memcpy(transaction->content_digest, content_digest, sizeof(content_digest));
  transaction->prepared = 1;
  if (test_pause("AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_AFTER_PREPARE") != 0)
    return RESULT_IO;
  return RESULT_OK;
}

static int rollback_swap(struct Transaction *transaction,
                         const char *stage_name,
                         const struct stat *staged_identity,
                         const struct stat *displaced_identity) {
  if (renameatx_np(transaction->parent_fd, stage_name, transaction->parent_fd,
                   transaction->leaf, RENAME_SWAP) != 0)
    return -1;
  struct stat restored;
  struct stat staged;
  if (fstatat(transaction->parent_fd, transaction->leaf, &restored,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_renamed_entry(displaced_identity, &restored) ||
      fstatat(transaction->parent_fd, stage_name, &staged,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_file_object(staged_identity, &staged))
    return -1;
  if (unlinkat(transaction->parent_fd, stage_name, 0) != 0 ||
      fsync(transaction->parent_fd) != 0)
    return -1;
  return 0;
}

static int commit_transaction(int root_fd, const char *root_path,
                              struct Transaction *transaction) {
  if (!transaction->active || !transaction->prepared || transaction->committed)
    return RESULT_INVALID;
  if (test_pause("AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_STAGE") != 0)
    return RESULT_IO;
  int parent_result = revalidate_parent(root_fd, root_path, transaction);
  if (parent_result != RESULT_OK)
    return parent_result;

  if (transaction->expected_absent) {
    struct stat unexpected;
    if (fstatat(transaction->parent_fd, transaction->leaf, &unexpected,
                AT_SYMLINK_NOFOLLOW) == 0 ||
        errno != ENOENT)
      return RESULT_CONFLICT;
  } else {
    struct stat retained;
    int current =
        openat(transaction->parent_fd, transaction->leaf, UNTRUSTED_READ_FLAGS);
    struct stat current_identity;
    if (current < 0 || fstat(transaction->expected_fd, &retained) != 0 ||
        fstat(current, &current_identity) != 0 ||
        !same_identity(&transaction->expected_identity, &retained) ||
        !same_identity(&transaction->expected_identity, &current_identity)) {
      if (current >= 0)
        close(current);
      return RESULT_CONFLICT;
    }
    close(current);
  }

  char stage_name[NAME_MAX + 1] = "";
  int stage_fd = create_stage(transaction->parent_fd,
                              transaction->request_id, stage_name);
  struct stat staged_identity;
  mode_t mode = transaction->expected_absent
                    ? 0644
                    : transaction->expected_identity.st_mode & 07777;
  char staged_digest[SHA256_HEX_BYTES + 1];
  int copied_xattrs = stage_fd < 0 || transaction->expected_absent
                          ? 1
                          : copy_supported_xattrs(transaction->expected_fd,
                                                  stage_fd);
  if (stage_fd < 0 ||
      write_all(stage_fd, transaction->contents, transaction->content_length) !=
          0 ||
      fchmod(stage_fd, mode) != 0 || copied_xattrs != 1 ||
      fsync(stage_fd) != 0 ||
      sha256_descriptor(stage_fd, MAX_CONTENT_BYTES, staged_digest,
                        &staged_identity) != 0 ||
      strcmp(staged_digest, transaction->content_digest) != 0) {
    if (stage_fd >= 0)
      close(stage_fd);
    if (stage_name[0] != '\0')
      (void)unlinkat(transaction->parent_fd, stage_name, 0);
    return RESULT_IO;
  }

  if (test_pause("AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_BEFORE_INSTALL") != 0) {
    close(stage_fd);
    (void)unlinkat(transaction->parent_fd, stage_name, 0);
    return RESULT_IO;
  }

  struct stat staged_before_install;
  struct stat retained_before_install;
  int staged_metadata = supported_metadata(stage_fd, &staged_identity);
  int retained_metadata = transaction->expected_absent
                              ? 1
                              : supported_metadata(
                                    transaction->expected_fd,
                                    &transaction->expected_identity);
  int matching_xattrs = transaction->expected_absent
                            ? 1
                            : matching_supported_xattrs(
                                  transaction->expected_fd, stage_fd);
  if (fstat(stage_fd, &staged_before_install) != 0 ||
      !same_identity(&staged_identity, &staged_before_install) ||
      staged_metadata != 1 || retained_metadata != 1 || matching_xattrs != 1 ||
      (!transaction->expected_absent &&
       (fstat(transaction->expected_fd, &retained_before_install) != 0 ||
        !same_identity(&transaction->expected_identity,
                       &retained_before_install) ||
        !same_preserved_metadata(&transaction->expected_identity,
                                 &staged_before_install)))) {
    close(stage_fd);
    (void)unlinkat(transaction->parent_fd, stage_name, 0);
    return staged_metadata < 0 || retained_metadata < 0 ||
                   matching_xattrs < 0
               ? RESULT_IO
               : RESULT_CONFLICT;
  }

  if (transaction->expected_absent) {
    if (renameatx_np(transaction->parent_fd, stage_name,
                     transaction->parent_fd, transaction->leaf,
                     RENAME_EXCL) != 0) {
      int failure = errno;
      close(stage_fd);
      (void)unlinkat(transaction->parent_fd, stage_name, 0);
      return failure == EEXIST ? RESULT_CONFLICT : RESULT_IO;
    }
    transaction->committed = 1;
    transaction->recovery_identity = staged_identity;
    int installed = verify_named_file(
        transaction->parent_fd, transaction->leaf, &staged_identity,
        transaction->content_digest, 1) &&
                    named_xattrs_match(transaction->parent_fd,
                                       transaction->leaf, stage_fd);
    int parent_live =
        revalidate_parent(root_fd, root_path, transaction) == RESULT_OK;
    if (!installed || !parent_live) {
      int removed = installed &&
                    unlinkat(transaction->parent_fd, transaction->leaf, 0) == 0 &&
                    fsync(transaction->parent_fd) == 0;
      close(stage_fd);
      if (removed) {
        transaction->committed = 0;
        return RESULT_CONFLICT;
      }
      return RESULT_INDETERMINATE;
    }
    int injected = test_fail_commit_fsync_once();
    if (injected != 0 || fsync(transaction->parent_fd) != 0) {
      close(stage_fd);
      return RESULT_INDETERMINATE;
    }
    transaction->commit_parent_synced = 1;
    close(stage_fd);
    return RESULT_OK;
  }

  if (renameatx_np(transaction->parent_fd, stage_name, transaction->parent_fd,
                   transaction->leaf, RENAME_SWAP) != 0) {
    close(stage_fd);
    (void)unlinkat(transaction->parent_fd, stage_name, 0);
    return RESULT_IO;
  }
  transaction->committed = 1;
  memcpy(transaction->recovery_name, stage_name, strlen(stage_name) + 1);
  int installed = verify_named_file(
      transaction->parent_fd, transaction->leaf, &staged_identity,
      transaction->content_digest, 1) &&
                  named_xattrs_match(transaction->parent_fd,
                                     transaction->leaf, stage_fd);
  struct stat displaced_entry;
  struct stat displaced;
  char displaced_digest[SHA256_HEX_BYTES + 1];
  int displaced_captured =
      fstatat(transaction->parent_fd, stage_name, &displaced_entry,
              AT_SYMLINK_NOFOLLOW) == 0;
  int displaced_valid = displaced_captured;
  if (displaced_valid) {
    int displaced_fd = openat(transaction->parent_fd, stage_name,
                              UNTRUSTED_READ_FLAGS);
    if (displaced_fd < 0 ||
        sha256_descriptor(displaced_fd, MAX_CONTENT_BYTES, displaced_digest,
                          &displaced) != 0 ||
        strcmp(displaced_digest, transaction->expected_digest) != 0 ||
        !same_renamed_identity(&transaction->expected_identity, &displaced) ||
        supported_metadata(displaced_fd, &displaced) != 1 ||
        matching_supported_xattrs(transaction->expected_fd, stage_fd) != 1)
      displaced_valid = 0;
    if (displaced_fd >= 0)
      close(displaced_fd);
  }
  int parent_live =
      revalidate_parent(root_fd, root_path, transaction) == RESULT_OK;
  if (!installed || !displaced_valid || !parent_live) {
    int rolled_back = displaced_captured &&
                      rollback_swap(transaction, stage_name, &staged_identity,
                                    &displaced_entry) == 0;
    close(stage_fd);
    if (rolled_back)
      transaction->committed = 0;
    return rolled_back ? RESULT_CONFLICT : RESULT_INDETERMINATE;
  }
  transaction->recovery_identity = displaced;
  int injected = test_fail_commit_fsync_once();
  if (injected != 0 || fsync(transaction->parent_fd) != 0) {
    close(stage_fd);
    return RESULT_INDETERMINATE;
  }
  transaction->commit_parent_synced = 1;
  if (test_pause("AIDEN_SUBAGENT_FILE_MUTATOR_TEST_PAUSE_AFTER_INSTALL") != 0) {
    close(stage_fd);
    return RESULT_INDETERMINATE;
  }
  close(stage_fd);
  return RESULT_OK;
}

static int verify_recovery(struct Transaction *transaction,
                           struct stat *verified) {
  if (transaction->expected_absent || transaction->recovery_unlinked ||
      transaction->expected_fd < 0)
    return RESULT_INDETERMINATE;
  struct stat retained;
  struct stat named;
  char retained_digest[SHA256_HEX_BYTES + 1];
  char named_digest[SHA256_HEX_BYTES + 1];
  int named_fd = openat(transaction->parent_fd, transaction->recovery_name,
                        UNTRUSTED_READ_FLAGS);
  if (named_fd < 0)
    return RESULT_CONFLICT;
  int valid =
      sha256_descriptor(transaction->expected_fd, MAX_CONTENT_BYTES,
                        retained_digest, &retained) == 0 &&
      sha256_descriptor(named_fd, MAX_CONTENT_BYTES, named_digest, &named) == 0 &&
      same_identity(&retained, &named) &&
      same_identity(&transaction->recovery_identity, &named) &&
      supported_metadata(transaction->expected_fd, &retained) == 1 &&
      supported_metadata(named_fd, &named) == 1 &&
      matches_expected_provenance(transaction, named_fd) &&
      strcmp(retained_digest, transaction->expected_digest) == 0 &&
      strcmp(named_digest, transaction->expected_digest) == 0;
  close(named_fd);
  if (!valid)
    return RESULT_CONFLICT;
  *verified = named;
  return RESULT_OK;
}

static int finalize_transaction(struct Transaction *transaction) {
  if (!transaction->active || !transaction->committed)
    return RESULT_INVALID;
  if (transaction->expected_absent) {
    if (verify_named_file(transaction->parent_fd, transaction->leaf,
                          &transaction->recovery_identity,
                          transaction->content_digest, 1) != 1 ||
        fsync(transaction->parent_fd) != 0)
      return RESULT_INDETERMINATE;
    clear_transaction(transaction);
    return RESULT_OK;
  }
  if (transaction->recovery_unlinked) {
    if (fsync(transaction->parent_fd) != 0)
      return RESULT_INDETERMINATE;
    clear_transaction(transaction);
    return RESULT_OK;
  }
  struct stat verified;
  int recovery = verify_recovery(transaction, &verified);
  if (recovery != RESULT_OK)
    return recovery;
  if (unlinkat(transaction->parent_fd, transaction->recovery_name, 0) != 0)
    return RESULT_CONFLICT;
  transaction->recovery_unlinked = 1;
  int injected = test_fail_finalize_fsync_once();
  if (injected != 0 || fsync(transaction->parent_fd) != 0)
    return RESULT_INDETERMINATE;
  clear_transaction(transaction);
  return RESULT_OK;
}

static int preserve_transaction(struct Transaction *transaction) {
  if (!transaction->active || !transaction->committed)
    return RESULT_INVALID;
  if (transaction->expected_absent || transaction->recovery_unlinked)
    return RESULT_INDETERMINATE;
  struct stat verified;
  int recovery = verify_recovery(transaction, &verified);
  if (recovery != RESULT_OK)
    return recovery;
  if (!transaction->commit_parent_synced) {
    if (fsync(transaction->parent_fd) != 0)
      return RESULT_INDETERMINATE;
    transaction->commit_parent_synced = 1;
  }
  clear_transaction(transaction);
  return RESULT_OK;
}

static void print_error(enum Result result) {
  const char *failure = result == RESULT_CONFLICT
                            ? "conflict"
                            : result == RESULT_INVALID
                                  ? "invalid_input"
                                  : result == RESULT_INDETERMINATE
                                        ? "indeterminate"
                                        : "io_failed";
  printf("error %s\n", failure);
}

static int serve(int root_fd, const char *root_path) {
  struct Transaction transaction;
  memset(&transaction, 0, sizeof(transaction));
  transaction.parent_fd = -1;
  transaction.expected_fd = -1;
  puts("ready");
  if (fflush(stdout) != 0)
    return EXIT_FAILURE;

  char *line = malloc(MAX_COMMAND_BYTES + 2);
  if (line == NULL)
    return EXIT_FAILURE;
  while (fgets(line, MAX_COMMAND_BYTES + 2, stdin) != NULL) {
    size_t length = strlen(line);
    if (length == 0 || line[length - 1] != '\n') {
      int character;
      while ((character = fgetc(stdin)) != '\n' && character != EOF) {
      }
      print_error(RESULT_INVALID);
      if (fflush(stdout) != 0)
        break;
      continue;
    }
    line[length - 1] = '\0';
    char *save = NULL;
    char *command = strtok_r(line, " ", &save);
    if (command == NULL) {
      print_error(RESULT_INVALID);
    } else if (strcmp(command, "inspect") == 0) {
      char *request_id = strtok_r(NULL, " ", &save);
      char *encoded_path = strtok_r(NULL, " ", &save);
      char *extra = strtok_r(NULL, " ", &save);
      enum Result result =
          request_id != NULL && encoded_path != NULL && extra == NULL
              ? inspect_transaction(root_fd, root_path, &transaction,
                                    request_id, encoded_path)
              : RESULT_INVALID;
      if (result == RESULT_OK) {
        if (transaction.expected_absent) {
          printf("inspected %s absent\n", transaction.request_id);
        } else {
          printf("inspected %s %s %zu ", transaction.request_id,
                 transaction.expected_digest, transaction.inspection_length);
          print_base64(transaction.inspection_contents,
                       transaction.inspection_length);
          putchar('\n');
        }
      } else {
        print_error(result);
      }
    } else if (strcmp(command, "prepare") == 0) {
      char *request_id = strtok_r(NULL, " ", &save);
      char *expected = strtok_r(NULL, " ", &save);
      char *encoded_path = strtok_r(NULL, " ", &save);
      char *encoded_contents = strtok_r(NULL, " ", &save);
      char *extra = strtok_r(NULL, " ", &save);
      enum Result result =
          request_id != NULL && expected != NULL && encoded_path != NULL &&
                  encoded_contents != NULL && extra == NULL
              ? prepare_transaction(root_fd, root_path, &transaction,
                                    request_id, expected, encoded_path,
                                    encoded_contents)
              : RESULT_INVALID;
      if (result == RESULT_OK) {
        printf("prepared %s %s %zu\n", transaction.request_id,
               transaction.content_digest, transaction.content_length);
      } else {
        print_error(result);
      }
    } else if (strcmp(command, "prepare-inspected") == 0) {
      char *request_id = strtok_r(NULL, " ", &save);
      char *expected = strtok_r(NULL, " ", &save);
      char *encoded_contents = strtok_r(NULL, " ", &save);
      char *extra = strtok_r(NULL, " ", &save);
      enum Result result =
          request_id != NULL && expected != NULL &&
                  encoded_contents != NULL && extra == NULL
              ? prepare_inspected_transaction(
                    root_fd, root_path, &transaction, request_id, expected,
                    encoded_contents)
              : RESULT_INVALID;
      if (result == RESULT_OK) {
        printf("prepared %s %s %zu\n", transaction.request_id,
               transaction.content_digest, transaction.content_length);
      } else {
        print_error(result);
      }
    } else if (strcmp(command, "commit") == 0) {
      char *request_id = strtok_r(NULL, " ", &save);
      char *extra = strtok_r(NULL, " ", &save);
      if (request_id == NULL || extra != NULL || !transaction.active ||
          strcmp(request_id, transaction.request_id) != 0) {
        print_error(RESULT_INVALID);
      } else {
        enum Result result =
            commit_transaction(root_fd, root_path, &transaction);
        if (result == RESULT_OK) {
          printf("committed %s %s %zu %s\n", transaction.request_id,
                 transaction.content_digest, transaction.content_length,
                 transaction.expected_absent ? "none"
                                             : transaction.recovery_name);
          if (transaction.expected_absent)
            clear_transaction(&transaction);
        } else {
          print_error(result);
          if (result != RESULT_INDETERMINATE && !transaction.committed)
            clear_transaction(&transaction);
        }
      }
    } else if (strcmp(command, "finalize") == 0) {
      char *request_id = strtok_r(NULL, " ", &save);
      char *extra = strtok_r(NULL, " ", &save);
      enum Result result =
          request_id != NULL && extra == NULL && transaction.active &&
                  strcmp(request_id, transaction.request_id) == 0
              ? finalize_transaction(&transaction)
              : RESULT_INVALID;
      if (result == RESULT_OK)
        printf("finalized %s\n", request_id);
      else
        print_error(result);
    } else if (strcmp(command, "preserve") == 0) {
      char *request_id = strtok_r(NULL, " ", &save);
      char *extra = strtok_r(NULL, " ", &save);
      if (request_id == NULL || extra != NULL || !transaction.active ||
          strcmp(request_id, transaction.request_id) != 0) {
        print_error(RESULT_INVALID);
      } else {
        enum Result result = preserve_transaction(&transaction);
        if (result == RESULT_OK)
          printf("preserved %s\n", request_id);
        else
          print_error(result);
      }
    } else if (strcmp(command, "cancel") == 0) {
      char *request_id = strtok_r(NULL, " ", &save);
      char *extra = strtok_r(NULL, " ", &save);
      if (request_id == NULL || extra != NULL || !transaction.active ||
          transaction.committed ||
          strcmp(request_id, transaction.request_id) != 0) {
        print_error(RESULT_INVALID);
      } else {
        clear_transaction(&transaction);
        printf("cancelled %s\n", request_id);
      }
    } else if (strcmp(command, "close") == 0 &&
               strtok_r(NULL, " ", &save) == NULL) {
      puts("ok");
      fflush(stdout);
      break;
    } else {
      print_error(RESULT_INVALID);
    }
    if (fflush(stdout) != 0)
      break;
  }
  clear_transaction(&transaction);
  free(line);
  return ferror(stdin) || ferror(stdout) ? EXIT_FAILURE : EXIT_SUCCESS;
}

static int parse_identity(const char *value, uint64_t *result) {
  if (value == NULL || value[0] == '\0')
    return -1;
  uint64_t parsed = 0;
  for (const unsigned char *cursor = (const unsigned char *)value;
       *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9')
      return -1;
    uint64_t digit = (uint64_t)(*cursor - '0');
    if (parsed > (UINT64_MAX - digit) / 10U)
      return -1;
    parsed = parsed * 10U + digit;
  }
  *result = parsed;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 8 || strcmp(argv[1], "serve") != 0 ||
      strcmp(argv[2], "--root") != 0 || strcmp(argv[4], "--device") != 0 ||
      strcmp(argv[6], "--inode") != 0 || argv[3][0] != '/')
    return EXIT_FAILURE;
  uint64_t expected_device;
  uint64_t expected_inode;
  if (parse_identity(argv[5], &expected_device) != 0 ||
      parse_identity(argv[7], &expected_inode) != 0)
    return EXIT_FAILURE;
  int root_fd =
      open(argv[3], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat root_identity;
  if (root_fd < 0 || fstat(root_fd, &root_identity) != 0 ||
      !S_ISDIR(root_identity.st_mode) ||
      (uint64_t)root_identity.st_dev != expected_device ||
      (uint64_t)root_identity.st_ino != expected_inode) {
    if (root_fd >= 0)
      close(root_fd);
    return EXIT_FAILURE;
  }
  int result = serve(root_fd, argv[3]);
  close(root_fd);
  return result;
}
