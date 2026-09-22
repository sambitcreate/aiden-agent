#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  pid_t first = fork();
  if (first < 0) return 70;
  if (first > 0) return 0;
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
    _exit(0);
  }
  // If the test itself dies before cleanup, this escaped child still exits.
  alarm(120);
  for (;;) pause();
}
