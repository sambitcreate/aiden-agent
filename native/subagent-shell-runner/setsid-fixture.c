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
  if (second > 0) _exit(0);
  FILE *marker = fopen(argv[1], "w");
  if (!marker) _exit(73);
  fprintf(marker, "%ld\n", (long)getpid());
  if (fclose(marker) != 0) _exit(74);
  for (;;) pause();
}
