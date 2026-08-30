#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _GNU_SOURCE
#endif

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#ifndef __APPLE__
#include <sys/prctl.h>
#endif
#include <time.h>
#include <unistd.h>

#define COMMAND_LIMIT (64U * 1024U)
#define STREAM_LIMIT (512U * 1024U)
#define NONCE_BYTES 64U
#define DIGEST_BYTES 64U
#define REQUEST_FIXED_BYTES 28U
#define RESPONSE_FIXED_BYTES 100U
#define CLEANUP_GRACE_MS 1000U

enum outcome {
  OUTCOME_EXITED = 1,
  OUTCOME_SIGNALED = 2,
  OUTCOME_TIMED_OUT = 3,
  OUTCOME_OUTPUT_LIMIT = 4,
  OUTCOME_CANCELLED = 5,
  OUTCOME_SPAWN_FAILED = 6,
  OUTCOME_PROTOCOL_FAILED = 7,
  OUTCOME_CLEANUP_UNCONFIRMED = 8,
};

struct request {
  char nonce[NONCE_BYTES + 1];
  char digest[DIGEST_BYTES + 1];
  uint32_t timeout_ms;
  uint32_t command_length;
  unsigned char command[COMMAND_LIMIT + 1];
};

struct capture {
  unsigned char bytes[STREAM_LIMIT];
  size_t length;
  bool open;
};

static uint64_t monotonic_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (uint64_t)value.tv_sec * 1000U + (uint64_t)value.tv_nsec / 1000000U;
}

static bool write_all(int fd, const void *bytes, size_t length) {
  const unsigned char *cursor = bytes;
  while (length > 0) {
    ssize_t written = write(fd, cursor, length);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return false;
    cursor += (size_t)written;
    length -= (size_t)written;
  }
  return true;
}

static bool read_all(int fd, void *bytes, size_t length) {
  unsigned char *cursor = bytes;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    cursor += (size_t)count;
    length -= (size_t)count;
  }
  return true;
}

static uint32_t read_u32(const unsigned char *bytes) {
  uint32_t value;
  memcpy(&value, bytes, sizeof(value));
  return ntohl(value);
}

static void write_u32(unsigned char *bytes, uint32_t value) {
  value = htonl(value);
  memcpy(bytes, &value, sizeof(value));
}

static bool lowercase_hex(const char *value, size_t length) {
  for (size_t index = 0; index < length; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}

static bool valid_utf8_command(const unsigned char *value, size_t length) {
  size_t index = 0;
  while (index < length) {
    unsigned char first = value[index];
    uint32_t codepoint;
    size_t width;
    if (first < 0x80U) {
      codepoint = first;
      width = 1;
    } else if ((first & 0xe0U) == 0xc0U) {
      codepoint = first & 0x1fU;
      width = 2;
    } else if ((first & 0xf0U) == 0xe0U) {
      codepoint = first & 0x0fU;
      width = 3;
    } else if ((first & 0xf8U) == 0xf0U) {
      codepoint = first & 0x07U;
      width = 4;
    } else {
      return false;
    }
    if (index + width > length) return false;
    for (size_t offset = 1; offset < width; offset += 1) {
      unsigned char continuation = value[index + offset];
      if ((continuation & 0xc0U) != 0x80U) return false;
      codepoint = (codepoint << 6U) | (continuation & 0x3fU);
    }
    if ((width == 2 && codepoint < 0x80U) || (width == 3 && codepoint < 0x800U) ||
        (width == 4 && codepoint < 0x10000U) || codepoint > 0x10ffffU ||
        (codepoint >= 0xd800U && codepoint <= 0xdfffU)) return false;
    if (codepoint == 0 || codepoint == 0x1bU || codepoint == 0x0dU ||
        (codepoint < 0x20U && codepoint != 0x09U && codepoint != 0x0aU) ||
        (codepoint >= 0x7fU && codepoint <= 0x9fU) || codepoint == 0x2028U ||
        codepoint == 0x2029U || (codepoint >= 0x202aU && codepoint <= 0x202eU) ||
        (codepoint >= 0x2066U && codepoint <= 0x2069U)) return false;
    index += width;
  }
  return length > 0;
}

static bool parse_request(struct request *request) {
  unsigned char fixed[REQUEST_FIXED_BYTES];
  if (!read_all(STDIN_FILENO, fixed, sizeof(fixed))) return false;
  if (memcmp(fixed, "AIDSH001", 8) != 0 || read_u32(fixed + 8) != 1U ||
      read_u32(fixed + 12) != NONCE_BYTES || read_u32(fixed + 16) != DIGEST_BYTES) return false;
  request->timeout_ms = read_u32(fixed + 20);
  request->command_length = read_u32(fixed + 24);
  if (request->timeout_ms < 1U || request->timeout_ms > 3600000U ||
      request->command_length < 1U || request->command_length > COMMAND_LIMIT) return false;
  if (!read_all(STDIN_FILENO, request->nonce, NONCE_BYTES) ||
      !read_all(STDIN_FILENO, request->digest, DIGEST_BYTES) ||
      !read_all(STDIN_FILENO, request->command, request->command_length)) return false;
  request->nonce[NONCE_BYTES] = '\0';
  request->digest[DIGEST_BYTES] = '\0';
  request->command[request->command_length] = '\0';
  return lowercase_hex(request->nonce, NONCE_BYTES) &&
         lowercase_hex(request->digest, DIGEST_BYTES) &&
         valid_utf8_command(request->command, request->command_length);
}

static bool parse_decimal(const char *value, uint64_t *result) {
  if (!value || !*value) return false;
  uint64_t parsed = 0;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') return false;
    if (parsed > (UINT64_MAX - (*cursor - '0')) / 10U) return false;
    parsed = parsed * 10U + (*cursor - '0');
  }
  *result = parsed;
  return true;
}

static int open_root(const char *path, uint64_t expected_device, uint64_t expected_inode) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISDIR(info.st_mode) ||
      (uint64_t)info.st_dev != expected_device || (uint64_t)info.st_ino != expected_inode) {
    close(fd);
    return -1;
  }
  return fd;
}

static bool make_private_tree(char *root, size_t capacity) {
  if (snprintf(root, capacity, "/tmp/aiden-subagent-shell.XXXXXX") >= (int)capacity) return false;
  if (!mkdtemp(root) || chmod(root, 0700) != 0) return false;
  const char *children[] = {"home", "tmp", "config", "cache", "data"};
  for (size_t index = 0; index < sizeof(children) / sizeof(children[0]); index += 1) {
    char path[1024];
    if (snprintf(path, sizeof(path), "%s/%s", root, children[index]) >= (int)sizeof(path) ||
        mkdir(path, 0700) != 0 || chmod(path, 0700) != 0) return false;
  }
  return true;
}

static void remove_tree(const char *path) {
  DIR *directory = opendir(path);
  if (!directory) return;
  int parent = dirfd(directory);
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    struct stat info;
    if (fstatat(parent, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) continue;
    if (S_ISDIR(info.st_mode)) {
      char child[2048];
      if (snprintf(child, sizeof(child), "%s/%s", path, entry->d_name) < (int)sizeof(child))
        remove_tree(child);
      (void)unlinkat(parent, entry->d_name, AT_REMOVEDIR);
    } else {
      (void)unlinkat(parent, entry->d_name, 0);
    }
  }
  closedir(directory);
  (void)rmdir(path);
}

static bool response(const struct request *request, enum outcome outcome, int exit_code,
                     int signal_number, bool cleanup, const struct capture *out,
                     const struct capture *err) {
  unsigned char fixed[RESPONSE_FIXED_BYTES];
  memset(fixed, 0, sizeof(fixed));
  memcpy(fixed, "AIDSR001", 8);
  write_u32(fixed + 8, 1U);
  write_u32(fixed + 12, (uint32_t)outcome);
  write_u32(fixed + 16, (uint32_t)exit_code);
  write_u32(fixed + 20, (uint32_t)signal_number);
  write_u32(fixed + 24, cleanup ? 1U : 0U);
  write_u32(fixed + 28, (uint32_t)out->length);
  write_u32(fixed + 32, (uint32_t)err->length);
  memcpy(fixed + 36, request->nonce, NONCE_BYTES);
  return write_all(STDOUT_FILENO, fixed, sizeof(fixed)) &&
         write_all(STDOUT_FILENO, request->digest, DIGEST_BYTES) &&
         write_all(STDOUT_FILENO, out->bytes, out->length) &&
         write_all(STDOUT_FILENO, err->bytes, err->length);
}

static bool drain_capture(int fd, struct capture *capture, bool *overflow) {
  unsigned char scratch[16384];
  ssize_t count = read(fd, scratch, sizeof(scratch));
  if (count < 0 && (errno == EINTR || errno == EAGAIN)) return true;
  if (count <= 0) {
    capture->open = false;
    close(fd);
    return true;
  }
  size_t available = STREAM_LIMIT - capture->length;
  size_t retained = (size_t)count < available ? (size_t)count : available;
  memcpy(capture->bytes + capture->length, scratch, retained);
  capture->length += retained;
  if (retained < (size_t)count) *overflow = true;
  return true;
}

static bool process_group_exists(pid_t group) {
  if (kill(-group, 0) == 0) return true;
  return errno != ESRCH;
}

static void close_inherited_descriptors(void) {
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 3 || maximum > 1048576) maximum = 1024;
  for (int descriptor = 3; descriptor < maximum; descriptor += 1) close(descriptor);
}

static bool cleanup_group(pid_t group, pid_t original_group, pid_t direct_child, struct capture *out,
                          struct capture *err, int out_fd, int err_fd) {
  (void)signal(SIGTERM, SIG_IGN);
  (void)kill(-group, SIGTERM);
  uint64_t deadline = monotonic_ms() + CLEANUP_GRACE_MS;
  bool overflow = false;
  while (monotonic_ms() < deadline && process_group_exists(group)) {
    struct pollfd fds[2] = {{out_fd, POLLIN | POLLHUP, 0}, {err_fd, POLLIN | POLLHUP, 0}};
    (void)poll(fds, 2, 20);
    if (out->open && fds[0].revents) (void)drain_capture(out_fd, out, &overflow);
    if (err->open && fds[1].revents) (void)drain_capture(err_fd, err, &overflow);
  }
  if (!process_group_exists(group)) return true;
  if (setpgid(0, original_group) != 0) return false;
  (void)kill(-group, SIGKILL);
  int ignored_status;
#ifndef __APPLE__
  /* As a Linux child subreaper, the helper adopts ordinary orphaned shell
   * descendants. Reap every child that stayed in the occupied process group
   * so a zombie cannot make kill(-group, 0) report a false cleanup failure. */
  for (;;) {
    pid_t reaped = waitpid(-group, &ignored_status, 0);
    if (reaped > 0) continue;
    if (reaped < 0 && errno == EINTR) continue;
    break;
  }
#endif
  while (waitpid(direct_child, &ignored_status, 0) < 0 && errno == EINTR) {}
  deadline = monotonic_ms() + 1000U;
  while (monotonic_ms() < deadline && process_group_exists(group)) usleep(10000);
  return !process_group_exists(group);
}

static int run_shell(const char *root_path, int root_fd, const struct request *request) {
#ifndef __APPLE__
  /* Electron is not guaranteed to be a child subreaper, and minimal desktop
   * or container sessions may not reap an orphan before the cleanup deadline.
   * Adopt ordinary descendants here so cleanup confirmation is deterministic. */
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) return 70;
#endif
  int stdout_pipe[2];
  int stderr_pipe[2];
  if (pipe(stdout_pipe) != 0 || pipe(stderr_pipe) != 0) return 70;
  char private_root[1024];
  if (!make_private_tree(private_root, sizeof(private_root))) return 70;
  pid_t original_group = getpgrp();
  pid_t child = fork();
  if (child < 0) return 70;
  if (child == 0) {
    (void)setpgid(0, 0);
    struct stat path_info;
    struct stat fd_info;
    if (lstat(root_path, &path_info) != 0 || fstat(root_fd, &fd_info) != 0 ||
        !S_ISDIR(path_info.st_mode) || path_info.st_dev != fd_info.st_dev ||
        path_info.st_ino != fd_info.st_ino || fchdir(root_fd) != 0) _exit(126);
    int devnull = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (devnull < 0 || dup2(devnull, STDIN_FILENO) < 0 ||
        dup2(stdout_pipe[1], STDOUT_FILENO) < 0 || dup2(stderr_pipe[1], STDERR_FILENO) < 0)
      _exit(126);
    close_inherited_descriptors();
    char home[1200], temporary[1200], config[1200], cache[1200], data[1200];
    snprintf(home, sizeof(home), "HOME=%s/home", private_root);
    snprintf(temporary, sizeof(temporary), "TMPDIR=%s/tmp", private_root);
    snprintf(config, sizeof(config), "XDG_CONFIG_HOME=%s/config", private_root);
    snprintf(cache, sizeof(cache), "XDG_CACHE_HOME=%s/cache", private_root);
    snprintf(data, sizeof(data), "XDG_DATA_HOME=%s/data", private_root);
#ifdef __APPLE__
    const char *shell_path = "/bin/zsh";
    char *shell_environment = "SHELL=/bin/zsh";
    char *arguments[] = {"/bin/zsh", "-f", "-c", (char *)request->command,
                         "aiden-subagent", NULL};
#else
    const char *shell_path = "/bin/sh";
    char *shell_environment = "SHELL=/bin/sh";
    char *arguments[] = {"/bin/sh", "-c", (char *)request->command,
                         "aiden-subagent", NULL};
#endif
    char *environment[] = {
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin", home, temporary, config, cache, data,
      "LANG=C", "LC_ALL=C", shell_environment, "TERM=dumb", "NO_COLOR=1", "CI=1",
      "PAGER=cat", "GIT_PAGER=cat", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/usr/bin/false",
      "SSH_ASKPASS=/usr/bin/false", "SSH_ASKPASS_REQUIRE=force", "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null", "NPM_CONFIG_USERCONFIG=/dev/null",
      "NPM_CONFIG_UPDATE_NOTIFIER=false", "NPM_CONFIG_FUND=false", "NPM_CONFIG_AUDIT=false",
      "ZDOTDIR=/dev/null", NULL,
    };
    execve(shell_path, arguments, environment);
    _exit(126);
  }
  (void)setpgid(child, child);
  if (setpgid(0, child) != 0) {
    (void)kill(child, SIGKILL);
    return 70;
  }
  close(stdout_pipe[1]);
  close(stderr_pipe[1]);
  (void)fcntl(stdout_pipe[0], F_SETFL, O_NONBLOCK);
  (void)fcntl(stderr_pipe[0], F_SETFL, O_NONBLOCK);
  struct capture out = {.length = 0, .open = true};
  struct capture err = {.length = 0, .open = true};
  enum outcome outcome = OUTCOME_SPAWN_FAILED;
  int exit_code = -1;
  int signal_number = 0;
  int wait_status = 0;
  bool child_exited = false;
  bool overflow = false;
  uint64_t deadline = monotonic_ms() + request->timeout_ms;
  while (!child_exited) {
    struct pollfd fds[3] = {
      {STDIN_FILENO, POLLIN | POLLHUP, 0},
      {stdout_pipe[0], POLLIN | POLLHUP, 0},
      {stderr_pipe[0], POLLIN | POLLHUP, 0},
    };
    (void)poll(fds, 3, 20);
    if (fds[0].revents & POLLHUP) {
      outcome = OUTCOME_CANCELLED;
      break;
    }
    if (fds[0].revents & POLLIN) {
      unsigned char extra;
      ssize_t count = read(STDIN_FILENO, &extra, 1);
      outcome = count == 0 ? OUTCOME_CANCELLED : OUTCOME_PROTOCOL_FAILED;
      break;
    }
    if (out.open && fds[1].revents) (void)drain_capture(stdout_pipe[0], &out, &overflow);
    if (err.open && fds[2].revents) (void)drain_capture(stderr_pipe[0], &err, &overflow);
    if (overflow) {
      outcome = OUTCOME_OUTPUT_LIMIT;
      break;
    }
    pid_t waited = waitpid(child, &wait_status, WNOHANG);
    if (waited == child) {
      child_exited = true;
      if (WIFEXITED(wait_status)) {
        outcome = OUTCOME_EXITED;
        exit_code = WEXITSTATUS(wait_status);
      } else if (WIFSIGNALED(wait_status)) {
        outcome = OUTCOME_SIGNALED;
        signal_number = WTERMSIG(wait_status);
      }
    } else if (waited < 0 && errno != EINTR) {
      outcome = OUTCOME_PROTOCOL_FAILED;
      break;
    }
    if (!child_exited && monotonic_ms() >= deadline) {
      outcome = OUTCOME_TIMED_OUT;
      break;
    }
  }
  bool cleaned = cleanup_group(child, original_group, child, &out, &err, stdout_pipe[0], stderr_pipe[0]);
  if (!child_exited) (void)waitpid(child, &wait_status, 0);
  if (out.open) close(stdout_pipe[0]);
  if (err.open) close(stderr_pipe[0]);
  remove_tree(private_root);
  if (!cleaned) outcome = OUTCOME_CLEANUP_UNCONFIRMED;
  (void)response(request, outcome, exit_code, signal_number, cleaned, &out, &err);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 8 || strcmp(argv[1], "serve") != 0 || strcmp(argv[2], "--root") != 0 ||
      strcmp(argv[4], "--device") != 0 || strcmp(argv[6], "--inode") != 0) return 64;
  uint64_t device;
  uint64_t inode;
  if (!parse_decimal(argv[5], &device) || !parse_decimal(argv[7], &inode)) return 64;
  int root_fd = open_root(argv[3], device, inode);
  if (root_fd < 0) return 65;
  struct request request;
  memset(&request, 0, sizeof(request));
  if (!parse_request(&request)) {
    struct capture empty = {.length = 0, .open = false};
    memset(request.nonce, '0', NONCE_BYTES);
    memset(request.digest, '0', DIGEST_BYTES);
    request.nonce[NONCE_BYTES] = '\0';
    request.digest[DIGEST_BYTES] = '\0';
    (void)response(&request, OUTCOME_PROTOCOL_FAILED, -1, 0, true, &empty, &empty);
    close(root_fd);
    return 66;
  }
  int result = run_shell(argv[3], root_fd, &request);
  close(root_fd);
  return result;
}
