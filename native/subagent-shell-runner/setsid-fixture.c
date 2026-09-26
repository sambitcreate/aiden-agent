#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#else
#define _GNU_SOURCE
#endif

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
  int stall_publication = 0;
  if (argc == 3) {
    if (strcmp(argv[2], "--delay-detach") == 0) detach_delay = 1;
    else if (strcmp(argv[2], "--stall-detach") == 0) detach_delay = 3;
    else if (strcmp(argv[2], "--stall-publish") == 0) stall_publication = 1;
    else return 64;
  }
  int ready[2];
  int grant[2];
  if (pipe(ready) < 0 || pipe(grant) < 0) return 69;
  (void)signal(SIGPIPE, SIG_IGN);
  pid_t first = fork();
  if (first < 0) return 70;
  if (first > 0) {
    close(ready[1]);
    close(grant[0]);
    // Stay in the command until detachment and PID publication are confirmed.
    // Bound the wait below the shell test's existing two-second deadline.
    int confirmed = await_publication(ready[0]);
    close(ready[0]);
    unsigned char allowed = 1;
    if (confirmed && write(grant[1], &allowed, 1) != 1) confirmed = 0;
    // Only this parent holds the writer. On failure every late-forked child
    // observes EOF, even if it detaches between the cleanup signals.
    close(grant[1]);
    if (!confirmed) {
      (void)kill(first, SIGKILL);
      (void)kill(-first, SIGKILL);
      (void)waitpid(first, NULL, WNOHANG);
      return 75;
    }
    (void)waitpid(first, NULL, WNOHANG);
    return 0;
  }
  close(ready[0]);
  close(grant[1]);
  if (detach_delay) sleep(detach_delay);
  if (setsid() < 0) _exit(71);
  pid_t second = fork();
  if (second < 0) _exit(72);
  if (second > 0) {
    close(grant[0]);
    if (stall_publication) {
      // Test witness is separate from the readiness marker deliberately absent
      // during timeout, so the test can assert and clean up the detached PID.
      char witness[4096];
      int length = snprintf(witness, sizeof(witness), "%s.spawned", argv[1]);
      FILE *spawned = length > 0 && length < (int)sizeof(witness) ? fopen(witness, "w") : NULL;
      if (!spawned) { kill(second, SIGKILL); _exit(77); }
      int written = fprintf(spawned, "%ld\n", (long)second);
      if (fclose(spawned) != 0 || written <= 0) { kill(second, SIGKILL); _exit(78); }
      sleep(3);
    }
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
  unsigned char allowed = 0;
  ssize_t received;
  do { received = read(grant[0], &allowed, 1); } while (received < 0 && errno == EINTR);
  close(grant[0]);
  if (received != 1 || allowed != 1) _exit(0);
  for (;;) pause();
}
