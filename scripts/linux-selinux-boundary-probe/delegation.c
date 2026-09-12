#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#define ROOT "/run/aiden-selinux-boundary-probe"
#define TOKEN "synthetic-probe-data\n"
static int context(char *value, size_t size) {
  int fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, value, size - 1); close(fd);
  if (n <= 0) return -1;
  value[n] = 0; return 0;
}
static int report(const char *operation, const char *stage, int fd, int truncated) {
  char label[256] = {0}, value[64];
  if (context(label, sizeof(label)) || !strstr(label, ":unconfined_t:") || !getuid()) return 70;
  ssize_t n = fd < 0 ? -1 : read(fd, value, sizeof(value));
  int error = fd < 0 ? 0 : n < 0 ? errno : 0;
  int success = n == sizeof(TOKEN) - 1 && !memcmp(value, TOKEN, sizeof(TOKEN) - 1);
  printf("{\"operation\":\"%s\",\"stage\":\"%s\",\"success\":%s,\"errno\":%d,\"truncated\":%s,\"uid\":%lu,\"pid\":%ld,\"context\":\"%s\"}\n", operation, stage, success ? "true" : "false", error, truncated ? "true" : "false", (unsigned long)getuid(), (long)getpid(), label);
  if (fd >= 0) close(fd);
  return 0; /* verifier distinguishes denial from fixture failures */
}
int main(int argc, char **argv) {
  alarm(6);
  if (argc != 2) return 64;
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, ROOT "/delegation.sock");
  if (!strcmp(argv[1], "scm-receiver")) {
    int server = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (server < 0 || bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 1)) return 71;
    int peer = accept4(server, NULL, NULL, SOCK_CLOEXEC);
    if (peer < 0) return 72;
    char byte; struct iovec iov = {.iov_base = &byte, .iov_len = 1};
    union {struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))];} control = {0};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
    if (recvmsg(peer, &message, 0) != 1 || byte != 'F') return 73;
    int fd = -1;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    if (header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS && header->cmsg_len == CMSG_LEN(sizeof(int))) memcpy(&fd, CMSG_DATA(header), sizeof(fd));
    close(peer); close(server);
    return report("scm", fd < 0 ? "receive-no-fd" : "read", fd, !!(message.msg_flags & MSG_CTRUNC));
  }
  char label[256] = {0};
  if (context(label, sizeof(label)) || !strstr(label, ":aiden_boundary_probe_t:") || !getuid()) return 74;
  int private_fd = open(ROOT "/private.txt", O_RDONLY);
  if (private_fd < 0) return 75;
  if (!strcmp(argv[1], "inherited-sender")) {
    if (dup2(private_fd, 10) != 10) return 76;
    if (private_fd != 10) close(private_fd);
    pid_t child = fork();
    if (child < 0) return 77;
    if (child == 0) {
      alarm(4);
      int attr = open("/proc/self/attr/current", O_WRONLY | O_CLOEXEC);
      const char *target = "system_u:system_r:unconfined_t:s0";
      if (attr < 0 || write(attr, target, strlen(target)) != (ssize_t)strlen(target)) _exit(78);
      close(attr);
      exit(report("inherited", "read", 10, 0));
    }
    int status;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 79;
    return WEXITSTATUS(status);
  }
  if (strcmp(argv[1], "scm-sender")) return 64;
  int peer = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (peer < 0 || connect(peer, (struct sockaddr *)&address, sizeof(address))) return 79;
  char byte = 'F'; struct iovec iov = {.iov_base = &byte, .iov_len = 1};
  union {struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))];} control = {0};
  struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &private_fd, sizeof(private_fd));
  return sendmsg(peer, &message, MSG_NOSIGNAL) == 1 ? 0 : 80;
}
