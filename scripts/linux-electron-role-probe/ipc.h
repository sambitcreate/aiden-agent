#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#define IPC_PATH "/run/aiden-electron-role-probe-ipc/transfer.sock"
#define IPC_TOKEN "synthetic-electron-token"
#define IPC_ACK "synthetic-electron-ack"
#define IPC_PROTECTED "system_u:object_r:aiden_electron_role_probe_protected_t:s0"
static int64_t now_ms(void) {
  struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int wait_io(int fd, short events, int64_t deadline) {
  for (;;) {
    int64_t left = deadline - now_ms();
    if (left <= 0) { errno = ETIMEDOUT; return -1; }
    struct pollfd p = {.fd = fd, .events = events};
    int result = poll(&p, 1, (int)left);
    if (result > 0) return 0;
    if (result == 0) { errno = ETIMEDOUT; return -1; }
    if (errno != EINTR) return -1;
  }
}
static int exact_io(int fd, void *buffer, size_t length, int writing, int64_t deadline) {
  size_t done = 0;
  while (done < length) {
    if (wait_io(fd, writing ? POLLOUT : POLLIN, deadline)) return -1;
    ssize_t n = writing ? send(fd, (char *)buffer + done, length - done, MSG_NOSIGNAL | MSG_DONTWAIT)
                        : recv(fd, (char *)buffer + done, length - done, MSG_DONTWAIT);
    if (n > 0) done += (size_t)n;
    else if (n == 0) { errno = EPIPE; return -1; }
    else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) return -1;
  }
  return 0;
}
static int current_context(char *value, size_t size) {
  int fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, value, size - 1); int saved = errno; close(fd); errno = saved;
  if (n <= 0 || n >= (ssize_t)size - 1) return -1;
  value[n] = 0; return 0;
}
static int peer_context(int fd, char *value, size_t size) {
  socklen_t length = (socklen_t)size - 1;
  if (getsockopt(fd, SOL_SOCKET, SO_PEERSEC, value, &length)) return -1;
  value[length] = 0; return 0;
}
