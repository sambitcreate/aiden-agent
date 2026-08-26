#ifndef __APPLE__
#define _GNU_SOURCE
#endif

#include "../shared/aiden-platform.h"
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

#define STORE_FILE "runs.json"
#define STAGING_PREFIX ".runs.json."
#define MAX_STORE_BYTES (8 * 1024 * 1024)
#define MAX_COMMAND_BYTES (((MAX_STORE_BYTES + 2) / 3) * 4 + 1024)
#define MAX_NAME_ATTEMPTS 32

/*
 * Opening a FIFO for reading blocks until a writer connects. The run store and
 * cleanup candidates are untrusted until fstat proves that they are expected
 * regular files, so every open of an existing untrusted path must be
 * nonblocking first. O_NONBLOCK has no observable effect on the regular-file
 * reads used by this protocol.
 */
#define UNTRUSTED_READ_FLAGS (O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)

enum InstallResult {
  INSTALL_OK = 0,
  INSTALL_DESTINATION_CHANGED = 1,
  INSTALL_IO_FAILED = 2,
};

static int same_timestamp(struct timespec left, struct timespec right) {
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

static int is_exclusive_regular_file(const struct stat *identity) {
  return S_ISREG(identity->st_mode) && identity->st_nlink == 1;
}

static int same_file_identity(const struct stat *left,
                              const struct stat *right) {
#ifdef __APPLE__
  return is_exclusive_regular_file(left) && is_exclusive_regular_file(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtimespec, right->st_mtimespec) &&
         same_timestamp(left->st_ctimespec, right->st_ctimespec) &&
         same_timestamp(left->st_birthtimespec, right->st_birthtimespec);
#else
  return is_exclusive_regular_file(left) && is_exclusive_regular_file(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtim, right->st_mtim) &&
         same_timestamp(left->st_ctim, right->st_ctim);
#endif
}

static int same_renamed_file_identity(const struct stat *left,
                                      const struct stat *right) {
#ifdef __APPLE__
  return is_exclusive_regular_file(left) && is_exclusive_regular_file(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtimespec, right->st_mtimespec) &&
         same_timestamp(left->st_birthtimespec, right->st_birthtimespec);
#else
  return is_exclusive_regular_file(left) && is_exclusive_regular_file(right) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_size == right->st_size &&
         same_timestamp(left->st_mtim, right->st_mtim);
#endif
}

static int requested_contents_match(int descriptor,
                                    const unsigned char *contents,
                                    size_t length) {
  unsigned char buffer[8192];
  size_t offset = 0;
  while (offset < length) {
    size_t chunk = length - offset;
    if (chunk > sizeof(buffer))
      chunk = sizeof(buffer);
    ssize_t bytes_read;
    do {
      bytes_read = pread(descriptor, buffer, chunk, (off_t)offset);
    } while (bytes_read < 0 && errno == EINTR);
    if (bytes_read < 0)
      return -1;
    if ((size_t)bytes_read != chunk ||
        memcmp(buffer, contents + offset, chunk) != 0) {
      return 0;
    }
    offset += chunk;
  }
  return 1;
}

/*
 * RENAME_SWAP may legitimately update ctime. Immediately after that operation
 * bind the installed inode to the exact requested bytes, bracketed by strict
 * identity checks. The later acknowledgement can then use this post-rename
 * snapshot: an in-place writer cannot restore ctime with utimensat, even if it
 * restores the original size and mtime.
 */
static int capture_installed_identity(int staged_fd,
                                      const struct stat *staged_identity,
                                      const unsigned char *contents,
                                      size_t length,
                                      struct stat *installed_identity) {
  struct stat before_read;
  struct stat after_read;
  if (fstat(staged_fd, &before_read) != 0)
    return INSTALL_IO_FAILED;
  if (!same_renamed_file_identity(staged_identity, &before_read))
    return INSTALL_DESTINATION_CHANGED;
  int contents_match = requested_contents_match(staged_fd, contents, length);
  if (contents_match < 0)
    return INSTALL_IO_FAILED;
  if (contents_match == 0)
    return INSTALL_DESTINATION_CHANGED;
  if (fstat(staged_fd, &after_read) != 0)
    return INSTALL_IO_FAILED;
  if (!same_file_identity(&before_read, &after_read))
    return INSTALL_DESTINATION_CHANGED;
  *installed_identity = after_read;
  return INSTALL_OK;
}

static int make_token(const struct stat *identity, char *token,
                      size_t capacity) {
#ifdef __APPLE__
  int length =
      snprintf(token, capacity, "%llx-%llx-%llx-%llx-%llx-%llx-%llx-%llx-%llx",
               (unsigned long long)identity->st_dev,
               (unsigned long long)identity->st_ino,
               (unsigned long long)identity->st_size,
               (unsigned long long)identity->st_mtimespec.tv_sec,
               (unsigned long long)identity->st_mtimespec.tv_nsec,
               (unsigned long long)identity->st_ctimespec.tv_sec,
               (unsigned long long)identity->st_ctimespec.tv_nsec,
               (unsigned long long)identity->st_birthtimespec.tv_sec,
               (unsigned long long)identity->st_birthtimespec.tv_nsec);
#else
  int length =
      snprintf(token, capacity, "%llx-%llx-%llx-%llx-%llx-%llx-%llx",
               (unsigned long long)identity->st_dev,
               (unsigned long long)identity->st_ino,
               (unsigned long long)identity->st_size,
               (unsigned long long)identity->st_mtim.tv_sec,
               (unsigned long long)identity->st_mtim.tv_nsec,
               (unsigned long long)identity->st_ctim.tv_sec,
               (unsigned long long)identity->st_ctim.tv_nsec);
#endif
  return length > 0 && (size_t)length < capacity ? 0 : -1;
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
        output_index == 23) {
      output[output_index++] = '-';
    }
    output[output_index++] = hex[bytes[byte_index] >> 4];
    output[output_index++] = hex[bytes[byte_index] & 0x0f];
  }
  output[36] = '\0';
}

static int make_owned_name(const char *suffix, char output[NAME_MAX + 1]) {
  char uuid[37];
  random_uuid(uuid);
  int length =
      snprintf(output, NAME_MAX + 1, "%s%s.%s", STAGING_PREFIX, uuid, suffix);
  return length > 0 && length <= NAME_MAX ? 0 : -1;
}

static int is_hex(char value) {
  return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
}

static int is_uuid(const char *value) {
  for (size_t index = 0; index < 36; index += 1) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (value[index] != '-')
        return 0;
    } else if (!is_hex(value[index])) {
      return 0;
    }
  }
  return value[36] == '\0';
}

static int is_owned_temporary_name(const char *name) {
  size_t prefix_length = strlen(STAGING_PREFIX);
  if (strncmp(name, STAGING_PREFIX, prefix_length) != 0)
    return 0;
  const char *uuid = name + prefix_length;
  if (strlen(uuid) < 40)
    return 0;
  char uuid_copy[37];
  memcpy(uuid_copy, uuid, 36);
  uuid_copy[36] = '\0';
  if (!is_uuid(uuid_copy) || uuid[36] != '.')
    return 0;
  return strcmp(uuid + 37, "tmp") == 0 || strcmp(uuid + 37, "cleanup") == 0;
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

static int decode_base64(const char *encoded, unsigned char **bytes,
                         size_t *length) {
  size_t encoded_length = strlen(encoded);
  if (encoded_length % 4 != 0 ||
      encoded_length > ((MAX_STORE_BYTES + 2) / 3) * 4) {
    return -1;
  }
  size_t padding = 0;
  if (encoded_length > 0 && encoded[encoded_length - 1] == '=')
    padding += 1;
  if (encoded_length > 1 && encoded[encoded_length - 2] == '=')
    padding += 1;
  size_t decoded_length = encoded_length / 4 * 3 - padding;
  if (decoded_length > MAX_STORE_BYTES)
    return -1;
  unsigned char *result = malloc(decoded_length == 0 ? 1 : decoded_length);
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
  *bytes = result;
  *length = decoded_length;
  return 0;
}

static char *encode_base64(const unsigned char *bytes, size_t length) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t encoded_length = ((length + 2) / 3) * 4;
  char *result = malloc(encoded_length + 1);
  if (result == NULL)
    return NULL;
  size_t input = 0;
  size_t output = 0;
  while (input < length) {
    size_t remaining = length - input;
    uint32_t value = (uint32_t)bytes[input++] << 16;
    if (remaining > 1)
      value |= (uint32_t)bytes[input++] << 8;
    if (remaining > 2)
      value |= bytes[input++];
    result[output++] = alphabet[(value >> 18) & 0x3f];
    result[output++] = alphabet[(value >> 12) & 0x3f];
    result[output++] = remaining > 1 ? alphabet[(value >> 6) & 0x3f] : '=';
    result[output++] = remaining > 2 ? alphabet[value & 0x3f] : '=';
  }
  result[output] = '\0';
  return result;
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

#ifdef AIDEN_SUBAGENT_RUN_STORE_TESTING
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
  int length =
      snprintf(continuation, sizeof(continuation), "%s.continue", marker);
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

/*
 * Capture a validated file under a fresh high-entropy name before unlinking.
 * A replacement at the source name is moved instead, rejected by identity,
 * restored when possible, and never deleted.
 */
static int discard_validated_file(int directory_fd, const char *source_name,
                                  const struct stat *expected,
                                  const char *pause_environment) {
  if (test_pause(pause_environment) != 0)
    return INSTALL_IO_FAILED;

  char captured_name[NAME_MAX + 1] = "";
  int captured = 0;
  for (int attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    if (make_owned_name("cleanup", captured_name) != 0)
      return INSTALL_IO_FAILED;
    if (renameatx_np(directory_fd, source_name, directory_fd, captured_name,
                     RENAME_EXCL) == 0) {
      captured = 1;
      break;
    }
    if (errno == ENOENT)
      return INSTALL_DESTINATION_CHANGED;
    if (errno != EEXIST)
      return INSTALL_IO_FAILED;
  }
  if (!captured)
    return INSTALL_IO_FAILED;

  struct stat current;
  if (fstatat(directory_fd, captured_name, &current, AT_SYMLINK_NOFOLLOW) !=
          0 ||
      !same_renamed_file_identity(expected, &current)) {
    (void)renameatx_np(directory_fd, captured_name, directory_fd, source_name,
                       RENAME_EXCL);
    (void)fsync(directory_fd);
    return INSTALL_DESTINATION_CHANGED;
  }
  if (fsync(directory_fd) != 0) {
    (void)renameatx_np(directory_fd, captured_name, directory_fd, source_name,
                       RENAME_EXCL);
    (void)fsync(directory_fd);
    return INSTALL_IO_FAILED;
  }
  if (unlinkat(directory_fd, captured_name, 0) != 0) {
    int unlink_error = errno;
    (void)renameatx_np(directory_fd, captured_name, directory_fd, source_name,
                       RENAME_EXCL);
    (void)fsync(directory_fd);
    return unlink_error == ENOENT ? INSTALL_DESTINATION_CHANGED
                                  : INSTALL_IO_FAILED;
  }
  return fsync(directory_fd) == 0 ? INSTALL_OK : INSTALL_IO_FAILED;
}

static int install_store(int directory_fd, const char *expected_token,
                         const unsigned char *contents, size_t length,
                         char token[256]);

static int read_store(int directory_fd) {
  int file_fd = openat(directory_fd, STORE_FILE, UNTRUSTED_READ_FLAGS);
  if (file_fd < 0) {
    if (errno == ENOENT) {
      puts("missing");
      return fflush(stdout) == 0 ? 0 : -1;
    }
    puts(errno == ELOOP ? "error destination_changed" : "error io_failed");
    return fflush(stdout) == 0 ? 0 : -1;
  }

  struct stat before;
  if (fstat(file_fd, &before) != 0 || !is_exclusive_regular_file(&before)) {
    close(file_fd);
    puts("error destination_changed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  if (test_pause("AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_AFTER_READ_STAT") != 0) {
    close(file_fd);
    puts("error io_failed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  char token[256];
  if (make_token(&before, token, sizeof(token)) != 0) {
    close(file_fd);
    puts("error io_failed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  if (before.st_size < 0 || before.st_size > MAX_STORE_BYTES) {
    close(file_fd);
    printf("oversize %s\n", token);
    return fflush(stdout) == 0 ? 0 : -1;
  }

  size_t length = (size_t)before.st_size;
  unsigned char *contents = malloc(length == 0 ? 1 : length);
  if (contents == NULL) {
    close(file_fd);
    puts("error io_failed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  size_t offset = 0;
  while (offset < length) {
    ssize_t count =
        pread(file_fd, contents + offset, length - offset, (off_t)offset);
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0) {
      free(contents);
      close(file_fd);
      puts("error destination_changed");
      return fflush(stdout) == 0 ? 0 : -1;
    }
    offset += (size_t)count;
  }
  struct stat after;
  if (fstat(file_fd, &after) != 0 || !same_file_identity(&before, &after)) {
    free(contents);
    close(file_fd);
    puts("error destination_changed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  if ((before.st_mode & 07777) != 0600) {
    int install_result =
        install_store(directory_fd, token, contents, length, token);
    if (install_result != INSTALL_OK) {
      free(contents);
      close(file_fd);
      puts(install_result == INSTALL_DESTINATION_CHANGED
               ? "error destination_changed"
               : "error io_failed");
      return fflush(stdout) == 0 ? 0 : -1;
    }
  }
  if (close(file_fd) != 0) {
    free(contents);
    puts("error io_failed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  char *encoded = encode_base64(contents, length);
  free(contents);
  if (encoded == NULL) {
    puts("error io_failed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  printf("data %s %s\n", token, encoded);
  free(encoded);
  return fflush(stdout) == 0 ? 0 : -1;
}

static int open_expected_destination(int directory_fd,
                                     const char *expected_token,
                                     struct stat *identity) {
  int descriptor = openat(directory_fd, STORE_FILE, UNTRUSTED_READ_FLAGS);
  if (descriptor < 0)
    return errno == ENOENT && strcmp(expected_token, "missing") == 0 ? -2 : -1;
  if (strcmp(expected_token, "missing") == 0) {
    close(descriptor);
    return -1;
  }
  char current_token[256];
  if (fstat(descriptor, identity) != 0 ||
      !is_exclusive_regular_file(identity) ||
      make_token(identity, current_token, sizeof(current_token)) != 0 ||
      strcmp(current_token, expected_token) != 0) {
    close(descriptor);
    return -1;
  }
  return descriptor;
}

static int create_staging_file(int directory_fd, char name[NAME_MAX + 1]) {
  for (int attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    if (make_owned_name("tmp", name) != 0)
      return -1;
    int descriptor =
        openat(directory_fd, name,
               O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (descriptor >= 0)
      return descriptor;
    if (errno != EEXIST)
      return -1;
  }
  return -1;
}

static int install_store(int directory_fd, const char *expected_token,
                         const unsigned char *contents, size_t length,
                         char token[256]) {
  struct stat expected_identity;
  int expected_fd = open_expected_destination(directory_fd, expected_token,
                                              &expected_identity);
  if (expected_fd == -1)
    return INSTALL_DESTINATION_CHANGED;

  char staged[NAME_MAX + 1] = "";
  int staged_fd = create_staging_file(directory_fd, staged);
  struct stat staged_identity;
  struct stat installed_after_rename;
  if (staged_fd < 0 || write_all(staged_fd, contents, length) != 0 ||
      fchmod(staged_fd, 0600) != 0 || fsync(staged_fd) != 0 ||
      fstat(staged_fd, &staged_identity) != 0 ||
      !is_exclusive_regular_file(&staged_identity)) {
    if (staged_fd >= 0)
      close(staged_fd);
    if (staged[0] != '\0')
      (void)unlinkat(directory_fd, staged, 0);
    if (expected_fd >= 0)
      close(expected_fd);
    return INSTALL_IO_FAILED;
  }

  if (expected_fd == -2) {
    if (renameatx_np(directory_fd, staged, directory_fd, STORE_FILE,
                     RENAME_EXCL) != 0) {
      int rename_error = errno;
      close(staged_fd);
      (void)unlinkat(directory_fd, staged, 0);
      return rename_error == EEXIST ? INSTALL_DESTINATION_CHANGED
                                    : INSTALL_IO_FAILED;
    }
    int capture_result = capture_installed_identity(
        staged_fd, &staged_identity, contents, length, &installed_after_rename);
    if (capture_result != INSTALL_OK) {
      close(staged_fd);
      return capture_result;
    }
  } else {
    struct stat retained;
    int current_fd = openat(directory_fd, STORE_FILE, UNTRUSTED_READ_FLAGS);
    struct stat current;
    if (current_fd < 0 || fstat(expected_fd, &retained) != 0 ||
        fstat(current_fd, &current) != 0 ||
        !same_file_identity(&expected_identity, &retained) ||
        !same_file_identity(&expected_identity, &current)) {
      if (current_fd >= 0)
        close(current_fd);
      close(staged_fd);
      close(expected_fd);
      (void)unlinkat(directory_fd, staged, 0);
      return INSTALL_DESTINATION_CHANGED;
    }
    close(current_fd);
    if (renameatx_np(directory_fd, staged, directory_fd, STORE_FILE,
                     RENAME_SWAP) != 0) {
      close(staged_fd);
      close(expected_fd);
      (void)unlinkat(directory_fd, staged, 0);
      return INSTALL_IO_FAILED;
    }
    int capture_result = capture_installed_identity(
        staged_fd, &staged_identity, contents, length, &installed_after_rename);
    if (capture_result != INSTALL_OK) {
      close(expected_fd);
      close(staged_fd);
      return capture_result;
    }
    struct stat displaced;
    if (fstatat(directory_fd, staged, &displaced, AT_SYMLINK_NOFOLLOW) != 0 ||
        !same_renamed_file_identity(&expected_identity, &displaced)) {
      int rollback = renameatx_np(directory_fd, staged, directory_fd,
                                  STORE_FILE, RENAME_SWAP);
      close(expected_fd);
      close(staged_fd);
      if (rollback == 0) {
        struct stat rolled_back_stage;
        if (fstatat(directory_fd, staged, &rolled_back_stage,
                    AT_SYMLINK_NOFOLLOW) == 0 &&
            same_renamed_file_identity(&staged_identity, &rolled_back_stage)) {
          (void)unlinkat(directory_fd, staged, 0);
        }
      }
      return rollback == 0 ? INSTALL_DESTINATION_CHANGED : INSTALL_IO_FAILED;
    }
    close(expected_fd);
    int discard_result = discard_validated_file(
        directory_fd, staged, &displaced,
        "AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_BEFORE_DISPLACED_CAPTURE");
    if (discard_result != INSTALL_OK) {
      close(staged_fd);
      return discard_result;
    }
  }

  if (test_pause("AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_AFTER_INSTALL") != 0) {
    close(staged_fd);
    return INSTALL_IO_FAILED;
  }

  if (fsync(directory_fd) != 0) {
    close(staged_fd);
    return INSTALL_IO_FAILED;
  }

  int installed_fd = openat(directory_fd, STORE_FILE, UNTRUSTED_READ_FLAGS);
  if (installed_fd < 0) {
    int open_error = errno;
    close(staged_fd);
    return open_error == ENOENT || open_error == ELOOP
               ? INSTALL_DESTINATION_CHANGED
               : INSTALL_IO_FAILED;
  }

  struct stat retained_stage;
  struct stat installed;
  if (fstat(staged_fd, &retained_stage) != 0 ||
      fstat(installed_fd, &installed) != 0) {
    close(installed_fd);
    close(staged_fd);
    return INSTALL_IO_FAILED;
  }
  if (!same_file_identity(&installed_after_rename, &retained_stage) ||
      !same_file_identity(&installed_after_rename, &installed)) {
    close(installed_fd);
    close(staged_fd);
    return INSTALL_DESTINATION_CHANGED;
  }
  if (make_token(&installed, token, 256) != 0) {
    close(installed_fd);
    close(staged_fd);
    return INSTALL_IO_FAILED;
  }
  close(installed_fd);
  if (close(staged_fd) != 0)
    return INSTALL_IO_FAILED;
  return INSTALL_OK;
}

static int write_store(int directory_fd, const char *expected_token,
                       const unsigned char *contents, size_t length) {
  char token[256];
  int install_result =
      install_store(directory_fd, expected_token, contents, length, token);
  if (install_result != INSTALL_OK) {
    puts(install_result == INSTALL_DESTINATION_CHANGED
             ? "error destination_changed"
             : "error io_failed");
    return fflush(stdout) == 0 ? 0 : -1;
  }
  printf("ok %s\n", token);
  return fflush(stdout) == 0 ? 0 : -1;
}

static int remove_owned_file(int directory_fd, const char *name) {
  int descriptor =
      openat(directory_fd, name, UNTRUSTED_READ_FLAGS);
  if (descriptor < 0)
    return errno == ENOENT || errno == ELOOP ? INSTALL_OK : INSTALL_IO_FAILED;
  struct stat expected;
  if (fstat(descriptor, &expected) != 0 || !S_ISREG(expected.st_mode)) {
    close(descriptor);
    return INSTALL_OK;
  }
  struct stat retained;
  if (fstat(descriptor, &retained) != 0 ||
      !same_file_identity(&expected, &retained)) {
    close(descriptor);
    return INSTALL_DESTINATION_CHANGED;
  }
  close(descriptor);
  return discard_validated_file(
      directory_fd, name, &retained,
      "AIDEN_SUBAGENT_RUN_STORE_TEST_PAUSE_BEFORE_CLEANUP_CAPTURE");
}

static int cleanup_store(int directory_fd) {
  int duplicate = openat(directory_fd, ".",
                         O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (duplicate < 0)
    return -1;
  DIR *directory = fdopendir(duplicate);
  if (directory == NULL) {
    close(duplicate);
    return -1;
  }
  int removed = 0;
  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(directory);
    if (entry == NULL)
      break;
    if (!is_owned_temporary_name(entry->d_name))
      continue;
    int remove_result = remove_owned_file(directory_fd, entry->d_name);
    if (remove_result != INSTALL_OK) {
      closedir(directory);
      return remove_result;
    }
    removed = 1;
  }
  int read_error = errno;
  if (closedir(directory) != 0 || read_error != 0)
    return INSTALL_IO_FAILED;
  if (removed && fsync(directory_fd) != 0)
    return INSTALL_IO_FAILED;
  printf("ok %d\n", removed);
  return fflush(stdout) == 0 ? INSTALL_OK : INSTALL_IO_FAILED;
}

static int serve(int directory_fd) {
  puts("ready");
  if (fflush(stdout) != 0)
    return 1;
  char *line = NULL;
  size_t capacity = 0;
  for (;;) {
    ssize_t length = getline(&line, &capacity, stdin);
    if (length < 0)
      break;
    if ((size_t)length > MAX_COMMAND_BYTES) {
      puts("error invalid_input");
      fflush(stdout);
      continue;
    }
    if (length > 0 && line[length - 1] == '\n')
      line[--length] = '\0';
    if (strcmp(line, "read") == 0) {
      if (read_store(directory_fd) != 0)
        break;
      continue;
    }
    if (strcmp(line, "cleanup") == 0) {
      int cleanup_result = cleanup_store(directory_fd);
      if (cleanup_result != INSTALL_OK) {
        puts(cleanup_result == INSTALL_DESTINATION_CHANGED
                 ? "error destination_changed"
                 : "error io_failed");
        if (fflush(stdout) != 0)
          break;
      }
      continue;
    }
    if (strcmp(line, "sync") == 0) {
      puts(fsync(directory_fd) == 0 ? "ok" : "error io_failed");
      if (fflush(stdout) != 0)
        break;
      continue;
    }
    if (strcmp(line, "close") == 0) {
      puts("ok");
      fflush(stdout);
      free(line);
      return 0;
    }
    if (strncmp(line, "write ", 6) == 0) {
      char *expected = line + 6;
      char *separator = strchr(expected, ' ');
      if (separator == NULL || separator == expected) {
        puts("error invalid_input");
        fflush(stdout);
        continue;
      }
      *separator = '\0';
      unsigned char *contents = NULL;
      size_t contents_length = 0;
      if (decode_base64(separator + 1, &contents, &contents_length) != 0) {
        puts("error invalid_input");
        fflush(stdout);
        continue;
      }
      int result =
          write_store(directory_fd, expected, contents, contents_length);
      free(contents);
      if (result != 0)
        break;
      continue;
    }
    puts("error invalid_input");
    if (fflush(stdout) != 0)
      break;
  }
  free(line);
  return ferror(stdin) ? 1 : 0;
}

int main(int argc, char **argv) {
  if (argc != 4 || strcmp(argv[1], "serve") != 0 ||
      strcmp(argv[2], "--directory") != 0 || argv[3][0] != '/') {
    fputs("invalid_input\n", stderr);
    return 64;
  }
  const char *directory = argv[3];
  if (strlen(directory) >= PATH_MAX) {
    fputs("invalid_input\n", stderr);
    return 64;
  }
  if (mkdir(directory, 0700) != 0 && errno != EEXIST) {
    fputs("io_failed\n", stderr);
    return 22;
  }
  int directory_fd =
      open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat identity;
  if (directory_fd < 0 || fstat(directory_fd, &identity) != 0 ||
      !S_ISDIR(identity.st_mode) || fchmod(directory_fd, 0700) != 0) {
    if (directory_fd >= 0)
      close(directory_fd);
    fputs("io_failed\n", stderr);
    return 22;
  }
  int result = serve(directory_fd);
  if (close(directory_fd) != 0 && result == 0)
    result = 1;
  return result;
}
