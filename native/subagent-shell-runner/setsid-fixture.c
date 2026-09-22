#include <errno.h>
#include <signal.h>
#include <poll.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

static long long monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int await_publication(int fd) {
  long long started = monotonic_ms();
  if (started < 0) return 0;
  long long deadline = started + 1500;
  for (;;) {
    long long now = monotonic_ms();
    if (now < 0 || now >= deadline) return 0;
    struct pollfd channel = {.fd = fd, .events = POLLIN};
    int available = poll(&channel, 1, (int)(deadline - now));
    if (available < 0 && errno == EINTR) continue;
    if (available <= 0 || !(channel.revents & POLLIN)) return 0;
    unsigned char published = 0;
    ssize_t count = read(fd, &published, 1);
    if (count < 0 && errno == EINTR) continue;
    return count == 1 && published == 1;
  }
}

int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 64;
  unsigned int detach_delay = 0;
  if (argc == 3) {
    if (strcmp(argv[2], "--delay-detach") == 0) detach_delay = 1;
    else if (strcmp(argv[2], "--stall-detach") == 0) detach_delay = 3;
    else return 64;
  }
  int ready[2];
  if (pipe(ready) < 0) return 69;
  pid_t first = fork();
  if (first < 0) return 70;
  if (first > 0) {
    close(ready[1]);
    // Stay in the command until detachment and PID publication are confirmed.
    // Bound the wait below the shell test's existing two-second deadline.
    int confirmed = await_publication(ready[0]);
    close(ready[0]);
    if (!confirmed) {
      (void)kill(-first, SIGKILL);
      (void)kill(first, SIGKILL);
      (void)waitpid(first, NULL, WNOHANG);
      return 75;
    }
    (void)waitpid(first, NULL, WNOHANG);
    return 0;
  }
  close(ready[0]);
  if (detach_delay) sleep(detach_delay);
  if (setsid() < 0) _exit(71);
  pid_t second = fork();
  if (second < 0) _exit(72);
  if (second > 0) {
    // The intermediate process knows the detached child's PID immediately.
    // Publish it before exiting so test scheduling cannot delay the marker.
    FILE *marker = fopen(argv[1], "w");
    if (!marker) { kill(second, SIGKILL); _exit(73); }
    int written = fprintf(marker, "%ld\n", (long)second);
    if (fclose(marker) != 0 || written <= 0) {
      kill(second, SIGKILL);
      _exit(74);
    }
    unsigned char published = 1;
    if (write(ready[1], &published, 1) != 1) {
      kill(second, SIGKILL);
      _exit(76);
    }
    close(ready[1]);
    _exit(0);
  }
  close(ready[1]);
  // If the test itself dies before cleanup, this escaped child still exits.
  alarm(120);
  for (;;) pause();
}
