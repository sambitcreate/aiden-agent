#include "ipc.h"
static int socket_creation(const char *context) {
  int fd = open("/proc/self/attr/sockcreate", O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t length = strlen(context); if (!length) length = 1;
  ssize_t written = write(fd, context, length); close(fd);
  return written == (ssize_t)length ? 0 : -1;
}
int main(void) {
  alarm(40);
  char context[256] = {0};
  if (current_context(context, sizeof(context)) || !getuid() || geteuid() != getuid() ||
      !strstr(context, ":aiden_electron_role_probe_sender_t:")) return 65;
  int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  struct sockaddr_un address = {.sun_family = AF_UNIX}; strcpy(address.sun_path, IPC_PATH);
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 4)) return 66;
  unsigned seen = 0;
  for (int index = 0; index < 4; index++) {
    int64_t deadline = now_ms() + 12000;
    if (wait_io(listener, POLLIN, deadline)) return 67;
    int peer = accept4(listener, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (peer < 0) return 68;
    char peer_label[256] = {0}; struct ucred credentials; socklen_t size = sizeof(credentials);
    if (peer_context(peer, peer_label, sizeof(peer_label)) || getsockopt(peer, SOL_SOCKET, SO_PEERCRED, &credentials, &size)) return 69;
    int main_role = !!strstr(peer_label, ":aiden_electron_role_probe_main_t:");
    if ((!main_role && !strstr(peer_label, ":aiden_electron_role_probe_child_t:")) || credentials.uid != getuid()) return 70;
    char channel;
    if (exact_io(peer, &channel, 1, 0, deadline) || (channel != 'G' && channel != 'P')) return 71;
    int protected_channel = channel == 'P';
    unsigned cell = 1U << ((main_role ? 0 : 2) + protected_channel);
    if (seen & cell) return 72;
    seen |= cell;
    if (protected_channel && socket_creation(IPC_PROTECTED)) return 73;
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, pair)) return 74;
    if (socket_creation("")) return 75;
    char socket_label[256] = {0};
    if (peer_context(pair[0], socket_label, sizeof(socket_label))) return 76;
    char byte = 'F'; struct iovec iov = {.iov_base = &byte, .iov_len = 1};
    union {struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))];} control = {0};
    struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(header), &pair[1], sizeof(pair[1]));
    if (exact_io(pair[0], IPC_TOKEN, sizeof(IPC_TOKEN) - 1, 1, deadline) || wait_io(peer, POLLOUT, deadline) || sendmsg(peer, &message, MSG_NOSIGNAL) != 1) return 77;
    close(pair[1]);
    char reply;
    if (exact_io(peer, &reply, 1, 0, deadline) || (reply != 'A' && reply != 'D')) return 78;
    char ack[sizeof(IPC_ACK) - 1];
    int roundtrip = reply == 'A' && !exact_io(pair[0], ack, sizeof(ack), 0, deadline) && !memcmp(ack, IPC_ACK, sizeof(ack));
    if (reply == 'A' && !roundtrip) return 79;
    printf("{\"channel\":\"%s\",\"pid\":%ld,\"uid\":%lu,\"context\":\"%s\",\"peerPid\":%ld,\"peerContext\":\"%s\",\"socketContext\":\"%s\",\"roundtrip\":%s,\"reply\":\"%c\"}\n", protected_channel ? "protected" : "generic", (long)getpid(), (unsigned long)getuid(), context, (long)credentials.pid, peer_label, socket_label, roundtrip ? "true" : "false", reply);
    fflush(stdout); close(pair[0]); close(peer);
  }
  close(listener); unlink(IPC_PATH);
  return seen == 15 ? 0 : 80;
}
