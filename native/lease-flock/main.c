#include <errno.h>
#include <sys/file.h>

/* fd 3 is a duplicate of the parent's open file description. The flock stays
 * with that description after this helper exits, until the parent closes it. */
int main(void) {
  if (flock(3, LOCK_EX | LOCK_NB) == 0) return 0;
  return (errno == EWOULDBLOCK || errno == EAGAIN) ? 10 : 11;
}
