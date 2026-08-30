#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#else
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
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

#define MAX_TELEGRAM_BYTES (20U * 1024U * 1024U)

static int safe_component(const char *value, size_t maximum) {
  size_t length = strlen(value);
  if (length == 0 || length > maximum || strcmp(value, ".") == 0 ||
      strcmp(value, "..") == 0) {
    return 0;
  }
  for (size_t index = 0; index < length; index += 1) {
    unsigned char character = (unsigned char)value[index];
    if (!((character >= 'A' && character <= 'Z') ||
          (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' ||
          character == '_' || character == '-')) {
      return 0;
    }
  }
  return 1;
}

static int parse_u64(const char *value, uint64_t *result) {
  if (value[0] == '\0' || (value[0] == '0' && value[1] != '\0')) return 0;
  uint64_t parsed = 0;
  for (size_t index = 0; value[index] != '\0'; index += 1) {
    unsigned char character = (unsigned char)value[index];
    if (character < '0' || character > '9') return 0;
    uint64_t digit = (uint64_t)(character - '0');
    if (parsed > (UINT64_MAX - digit) / 10U) return 0;
    parsed = parsed * 10U + digit;
  }
  *result = parsed;
  return 1;
}

static int open_directory_at(int parent, const char *name) {
  if (mkdirat(parent, name, 0700) != 0 && errno != EEXIST) return -1;
  int descriptor = openat(parent, name,
                          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return -1;
  struct stat metadata;
  if (fstat(descriptor, &metadata) != 0 || !S_ISDIR(metadata.st_mode) ||
      metadata.st_uid != geteuid()) {
    close(descriptor);
    errno = EPERM;
    return -1;
  }
  if (fchmod(descriptor, 0700) != 0) {
    close(descriptor);
    return -1;
  }
  return descriptor;
}

static int write_all(int descriptor, const unsigned char *bytes, size_t count) {
  size_t offset = 0;
  while (offset < count) {
    ssize_t written = write(descriptor, bytes + offset, count - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return 0;
}

#if defined(AIDEN_BOT_INBOX_WRITER_TESTING)
static int test_checkpoint(char marker) {
  const char *enabled = getenv("AIDEN_BOT_INBOX_WRITER_TEST_HANDSHAKE");
  if (enabled == NULL || strcmp(enabled, "1") != 0) return 0;
  if (write_all(3, (const unsigned char *)&marker, 1) != 0) return -1;
  char response = '\0';
  ssize_t received;
  do {
    received = read(4, &response, 1);
  } while (received < 0 && errno == EINTR);
  return received == 1 && response == marker ? 0 : -1;
}
#else
static int test_checkpoint(char marker) {
  (void)marker;
  return 0;
}
#endif

static int fail_with_cleanup(int directory, const char *leaf, int file) {
  if (file >= 0) close(file);
  if (directory >= 0 && leaf != NULL) {
    (void)unlinkat(directory, leaf, 0);
    (void)fsync(directory);
  }
  if (directory >= 0) close(directory);
  (void)fputs("Bot inbox write failed.\n", stderr);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 13 || strcmp(argv[1], "--home") != 0 ||
      strcmp(argv[3], "--device") != 0 || strcmp(argv[5], "--inode") != 0 ||
      strcmp(argv[7], "--profile") != 0 || strcmp(argv[9], "--leaf") != 0 ||
      strcmp(argv[11], "--size") != 0 || argv[2][0] != '/') {
    return fail_with_cleanup(-1, NULL, -1);
  }

  uint64_t expected_device = 0;
  uint64_t expected_inode = 0;
  uint64_t declared_size = 0;
  if (!parse_u64(argv[4], &expected_device) ||
      !parse_u64(argv[6], &expected_inode) ||
      !parse_u64(argv[12], &declared_size) ||
      declared_size > MAX_TELEGRAM_BYTES || !safe_component(argv[8], 120) ||
      !safe_component(argv[10], 200)) {
    return fail_with_cleanup(-1, NULL, -1);
  }

  int home = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (home < 0) return fail_with_cleanup(-1, NULL, -1);
  struct stat home_metadata;
  if (fstat(home, &home_metadata) != 0 || !S_ISDIR(home_metadata.st_mode) ||
      (uint64_t)home_metadata.st_dev != expected_device ||
      (uint64_t)home_metadata.st_ino != expected_inode ||
      home_metadata.st_uid != geteuid()) {
    close(home);
    return fail_with_cleanup(-1, NULL, -1);
  }

  int aiden = open_directory_at(home, ".aiden");
  if (aiden < 0) {
    close(home);
    return fail_with_cleanup(-1, NULL, -1);
  }
  int telegram = open_directory_at(aiden, "telegram-inbox");
  close(aiden);
  if (telegram < 0) {
    close(home);
    return fail_with_cleanup(-1, NULL, -1);
  }
  int inbox = open_directory_at(telegram, argv[8]);
  close(telegram);
  if (inbox < 0) {
    close(home);
    return fail_with_cleanup(-1, NULL, -1);
  }

  if (test_checkpoint('R') != 0) {
    close(home);
    return fail_with_cleanup(inbox, NULL, -1);
  }

  if (fstat(home, &home_metadata) != 0 ||
      (uint64_t)home_metadata.st_dev != expected_device ||
      (uint64_t)home_metadata.st_ino != expected_inode) {
    close(home);
    return fail_with_cleanup(inbox, NULL, -1);
  }
  close(home);

  int file = openat(inbox, argv[10],
                    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                    0600);
  if (file < 0) return fail_with_cleanup(inbox, NULL, -1);

  unsigned char buffer[64U * 1024U];
  uint64_t remaining = declared_size;
  while (remaining > 0) {
    size_t requested = remaining < sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
    ssize_t received = read(STDIN_FILENO, buffer, requested);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0 || write_all(file, buffer, (size_t)received) != 0) {
      return fail_with_cleanup(inbox, argv[10], file);
    }
    remaining -= (uint64_t)received;
  }
  unsigned char extra = 0;
  ssize_t extra_count;
  do {
    extra_count = read(STDIN_FILENO, &extra, 1);
  } while (extra_count < 0 && errno == EINTR);
  if (extra_count != 0 || fchmod(file, 0600) != 0 || fsync(file) != 0 ||
      close(file) != 0 || fsync(inbox) != 0 || test_checkpoint('D') != 0) {
    return fail_with_cleanup(inbox, argv[10], -1);
  }
  close(inbox);
  if (fputs("ok\n", stdout) == EOF || fflush(stdout) != 0) return 1;
  return 0;
}
