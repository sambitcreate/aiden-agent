#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#define ROOT "/run/aiden-protected-ipc-probe"
#define TOKEN "synthetic-channel-token"
#define ACK "synthetic-channel-ack"
static int read_context(char *value, size_t size) {
  int fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, value, size - 1); close(fd);
  if (n <= 0) return -1;
  value[n] = 0; return 0;
}
static int set_socket_context(const char *value) {
  int fd = open("/proc/self/attr/sockcreate", O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t size = strlen(value);
  /* Writing one NUL byte resets the per-task socket creation context. */
  ssize_t n = write(fd, value, size ? size : 1); close(fd);
  return n == (ssize_t)(size ? size : 1) ? 0 : -1;
}
static int exact_read(int fd, const char *expected) {
  char value[64]; size_t size = strlen(expected), offset = 0;
  while (offset < size) {
    ssize_t n = read(fd, value + offset, size - offset);
    if (n <= 0) return 0;
    offset += (size_t)n;
  }
  return !memcmp(value, expected, size);
}
static int exact_write(int fd, const char *value) {
  size_t size = strlen(value), offset = 0;
  while (offset < size) {
    ssize_t n = send(fd, value + offset, size - offset, MSG_NOSIGNAL);
    if (n <= 0) return 0;
    offset += (size_t)n;
  }
  return 1;
}
int main(int argc, char **argv) {
  alarm(6);
  if (argc != 3 || (strcmp(argv[2], "generic") && strcmp(argv[2], "protected"))) return 64;
  char context[256] = {0};
  if (read_context(context, sizeof(context)) || !getuid()) return 65;
  int receiving = !strcmp(argv[1], "receive");
  if (!receiving && strcmp(argv[1], "send")) return 64;
  if (!strstr(context, receiving ? ":unconfined_t:" : ":aiden_ipc_sender_t:")) return 66;
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  strcpy(address.sun_path, ROOT "/transfer.sock");
  int transport = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (transport < 0) return 67;
  char byte = 'F'; struct iovec iov = {.iov_base = &byte, .iov_len = 1};
  union {struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))];} control = {0};
  struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  if (receiving) {
    if (bind(transport, (struct sockaddr *)&address, sizeof(address)) || listen(transport, 1)) return 68;
    int peer = accept4(transport, NULL, NULL, SOCK_CLOEXEC);
    if (peer < 0) return 69;
    if (recvmsg(peer, &message, MSG_CMSG_CLOEXEC) != 1 || byte != 'F') return 70;
    int endpoint = -1;
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    if (header && header->cmsg_level == SOL_SOCKET && header->cmsg_type == SCM_RIGHTS && header->cmsg_len == CMSG_LEN(sizeof(int))) memcpy(&endpoint, CMSG_DATA(header), sizeof(endpoint));
    int got_token = 0, sent_ack = 0, error = 0;
    if (endpoint >= 0) {
      got_token = exact_read(endpoint, TOKEN);
      if (!got_token) error = errno;
      if (got_token) { sent_ack = exact_write(endpoint, ACK); if (!sent_ack) error = errno; }
      close(endpoint);
    }
    if (!exact_write(peer, endpoint < 0 ? "D" : got_token && sent_ack ? "A" : "E")) return 71;
    printf("{\"channel\":\"%s\",\"uid\":%lu,\"pid\":%ld,\"context\":\"%s\",\"receivedFd\":%s,\"truncated\":%s,\"tokenRead\":%s,\"ackWritten\":%s,\"errno\":%d}\n", argv[2], (unsigned long)getuid(), (long)getpid(), context, endpoint >= 0 ? "true" : "false", message.msg_flags & MSG_CTRUNC ? "true" : "false", got_token ? "true" : "false", sent_ack ? "true" : "false", error);
    close(peer); close(transport); return 0;
  }
  if (connect(transport, (struct sockaddr *)&address, sizeof(address))) return 72;
  int pair[2];
  if (!strcmp(argv[2], "protected") && set_socket_context("system_u:object_r:aiden_ipc_protected_socket_t:s0")) return 73;
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) return 74;
  if (set_socket_context("")) return 75;
  char socket_context[256] = {0}; socklen_t label_size = sizeof(socket_context) - 1;
  if (getsockopt(pair[0], SOL_SOCKET, SO_PEERSEC, socket_context, &label_size)) return 76;
  if (!strstr(socket_context, !strcmp(argv[2], "protected") ? ":aiden_ipc_protected_socket_t:" : ":aiden_ipc_sender_t:")) return 77;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &pair[1], sizeof(pair[1]));
  if (!exact_write(pair[0], TOKEN) || sendmsg(transport, &message, MSG_NOSIGNAL) != 1) return 78;
  close(pair[1]);
  char reply;
  if (read(transport, &reply, 1) != 1 || (reply != 'A' && reply != 'D' && reply != 'E')) return 79;
  int roundtrip = reply == 'A' && exact_read(pair[0], ACK);
  if (reply == 'A' && !roundtrip) return 80;
  printf("{\"channel\":\"%s\",\"uid\":%lu,\"pid\":%ld,\"context\":\"%s\",\"socketContext\":\"%s\",\"roundtrip\":%s,\"receiverReply\":\"%c\"}\n", argv[2], (unsigned long)getuid(), (long)getpid(), context, socket_context, roundtrip ? "true" : "false", reply);
  close(pair[0]); close(transport); return 0;
}
