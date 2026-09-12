#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

#define ROOT "/run/aiden-selinux-boundary-probe"
#define TOKEN "synthetic-probe-data\n"
static volatile sig_atomic_t stopped;
static void stop(int signal_number) { (void)signal_number; stopped = 1; }
static int report(const char *operation, int success, int error) {
  printf("{\"operation\":\"%s\",\"success\":%s,\"errno\":%d,\"uid\":%lu,\"pid\":%ld}\n",
    operation, success ? "true" : "false", error, (unsigned long)getuid(), (long)getpid());
  return success ? 0 : 1;
}
static int holder(void) {
  char context[256] = {0};
  int context_fd = open("/proc/self/attr/current", O_RDONLY | O_CLOEXEC);
  if (context_fd < 0) return 7;
  ssize_t context_size = read(context_fd, context, sizeof(context) - 1);
  close(context_fd);
  if (context_size <= 0 || strstr(context, ":aiden_boundary_probe_t:") == NULL || getuid() == 0) return 8;
  /* Deliberately dumpable: the experiment must not mistake dumpability for MAC. */
  if (prctl(PR_SET_DUMPABLE, 1) != 0) return 2;
  int private_fd = open(ROOT "/private.txt", O_RDONLY);
  if (private_fd != 3) return 3; /* fixed descriptor for pidfd/proc test */
  int server = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (server < 0) return 4;
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  snprintf(address.sun_path, sizeof(address.sun_path), "%s/socket", ROOT);
  unlink(address.sun_path);
  if (bind(server, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(server, 8) != 0) return 5;
  struct sigaction action = { .sa_handler = stop };
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  signal(SIGPIPE, SIG_IGN);
  while (!stopped) {
    int client = accept4(server, NULL, NULL, SOCK_CLOEXEC);
    if (client < 0) { if (errno == EINTR) continue; return 6; }
    (void)write(client, TOKEN, sizeof(TOKEN) - 1);
    close(client);
  }
  close(server);
  close(private_fd);
  return 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "holder") == 0) return holder();
  if (argc == 2 && strcmp(argv[1], "file") == 0) {
    int fd = open(ROOT "/private.txt", O_RDONLY);
    if (fd < 0) return report("file", 0, errno);
    char value[64]; ssize_t n = read(fd, value, sizeof(value)); int error = errno; close(fd);
    return report("file", n == (ssize_t)(sizeof(TOKEN) - 1) && memcmp(value, TOKEN, sizeof(TOKEN) - 1) == 0, n < 0 ? error : 0);
  }
  if (argc == 2 && strcmp(argv[1], "socket") == 0) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return report("socket", 0, errno);
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    snprintf(address.sun_path, sizeof(address.sun_path), "%s/socket", ROOT);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) { int error = errno; close(fd); return report("socket", 0, error); }
    char value[64]; ssize_t n = read(fd, value, sizeof(value)); int error = errno; close(fd);
    return report("socket", n > 0, n < 0 ? error : 0);
  }
  if (argc != 3) return 64;
  char *end = NULL; long pid = strtol(argv[2], &end, 10);
  if (!end || *end || pid <= 1 || pid > 2147483647L) return 64;
  if (strcmp(argv[1], "proc") == 0) {
    char file[96]; snprintf(file, sizeof(file), "/proc/%ld/comm", pid);
    int fd = open(file, O_RDONLY);
    if (fd < 0) return report("proc", 0, errno);
    char value[64]; ssize_t n = read(fd, value, sizeof(value)); int error = errno; close(fd);
    return report("proc", n > 0, n < 0 ? error : 0);
  }
  if (strcmp(argv[1], "proc-fd") == 0) {
    char file[96], value[512]; snprintf(file, sizeof(file), "/proc/%ld/fd/3", pid);
    ssize_t n = readlink(file, value, sizeof(value));
    return report("proc-fd", n > 0, n < 0 ? errno : 0);
  }
  if (strcmp(argv[1], "ptrace") == 0) {
    if (ptrace(PTRACE_SEIZE, (pid_t)pid, NULL, NULL) != 0) return report("ptrace", 0, errno);
    (void)ptrace(PTRACE_DETACH, (pid_t)pid, NULL, NULL);
    return report("ptrace", 1, 0);
  }
  if (strcmp(argv[1], "pidfd") == 0) {
    int pidfd = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (pidfd < 0) return report("pidfd", 0, errno);
    int fd = (int)syscall(SYS_pidfd_getfd, pidfd, 3, 0); int error = errno;
    close(pidfd); if (fd >= 0) close(fd);
    return report("pidfd", fd >= 0, fd < 0 ? error : 0);
  }
  return 64;
}
