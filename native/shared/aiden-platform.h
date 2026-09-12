#ifndef AIDEN_PLATFORM_H
#define AIDEN_PLATFORM_H

#ifdef __APPLE__

#include <CommonCrypto/CommonDigest.h>

#else

#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/random.h>
#include <sys/syscall.h>
#include <unistd.h>

/*
 * Keep the native safety helpers self-contained. Depending on a particular
 * OpenSSL ABI would make the AppImage fail on otherwise supported distros.
 * This small SHA-256 implementation exposes the CommonCrypto subset used by
 * the existing audited helper code.
 */
#define CC_SHA256_DIGEST_LENGTH 32
typedef uint32_t CC_LONG;
typedef struct {
  uint8_t data[64];
  uint32_t data_length;
  uint64_t bit_length;
  uint32_t state[8];
} CC_SHA256_CTX;

static inline uint32_t aiden_sha256_rotr(uint32_t value, uint32_t amount) {
  return (value >> amount) | (value << (32U - amount));
}

static inline void aiden_sha256_transform(CC_SHA256_CTX *context,
                                          const uint8_t data[64]) {
  static const uint32_t constants[64] = {
      0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU,
      0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U,
      0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U,
      0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
      0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U,
      0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
      0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
      0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
      0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U,
      0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U, 0x1e376c08U,
      0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU,
      0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
      0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
  };
  uint32_t words[64];
  for (uint32_t index = 0; index < 16; index += 1) {
    words[index] = ((uint32_t)data[index * 4] << 24U) |
                   ((uint32_t)data[index * 4 + 1] << 16U) |
                   ((uint32_t)data[index * 4 + 2] << 8U) |
                   (uint32_t)data[index * 4 + 3];
  }
  for (uint32_t index = 16; index < 64; index += 1) {
    uint32_t s0 = aiden_sha256_rotr(words[index - 15], 7U) ^
                  aiden_sha256_rotr(words[index - 15], 18U) ^
                  (words[index - 15] >> 3U);
    uint32_t s1 = aiden_sha256_rotr(words[index - 2], 17U) ^
                  aiden_sha256_rotr(words[index - 2], 19U) ^
                  (words[index - 2] >> 10U);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }
  uint32_t a = context->state[0];
  uint32_t b = context->state[1];
  uint32_t c = context->state[2];
  uint32_t d = context->state[3];
  uint32_t e = context->state[4];
  uint32_t f = context->state[5];
  uint32_t g = context->state[6];
  uint32_t h = context->state[7];
  for (uint32_t index = 0; index < 64; index += 1) {
    uint32_t s1 = aiden_sha256_rotr(e, 6U) ^ aiden_sha256_rotr(e, 11U) ^
                  aiden_sha256_rotr(e, 25U);
    uint32_t choice = (e & f) ^ ((~e) & g);
    uint32_t temporary1 = h + s1 + choice + constants[index] + words[index];
    uint32_t s0 = aiden_sha256_rotr(a, 2U) ^ aiden_sha256_rotr(a, 13U) ^
                  aiden_sha256_rotr(a, 22U);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temporary2 = s0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary1;
    d = c;
    c = b;
    b = a;
    a = temporary1 + temporary2;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static inline int CC_SHA256_Init(CC_SHA256_CTX *context) {
  context->data_length = 0;
  context->bit_length = 0;
  context->state[0] = 0x6a09e667U;
  context->state[1] = 0xbb67ae85U;
  context->state[2] = 0x3c6ef372U;
  context->state[3] = 0xa54ff53aU;
  context->state[4] = 0x510e527fU;
  context->state[5] = 0x9b05688cU;
  context->state[6] = 0x1f83d9abU;
  context->state[7] = 0x5be0cd19U;
  return 1;
}

static inline int CC_SHA256_Update(CC_SHA256_CTX *context, const void *input,
                                   CC_LONG length) {
  const uint8_t *bytes = input;
  for (CC_LONG index = 0; index < length; index += 1) {
    context->data[context->data_length++] = bytes[index];
    if (context->data_length == 64U) {
      aiden_sha256_transform(context, context->data);
      context->bit_length += 512U;
      context->data_length = 0;
    }
  }
  return 1;
}

static inline int CC_SHA256_Final(
    unsigned char digest[CC_SHA256_DIGEST_LENGTH], CC_SHA256_CTX *context) {
  uint32_t index = context->data_length;
  context->data[index++] = 0x80U;
  if (index > 56U) {
    while (index < 64U) context->data[index++] = 0;
    aiden_sha256_transform(context, context->data);
    index = 0;
  }
  while (index < 56U) context->data[index++] = 0;
  context->bit_length += (uint64_t)context->data_length * 8U;
  for (uint32_t byte = 0; byte < 8U; byte += 1) {
    context->data[63U - byte] =
        (uint8_t)(context->bit_length >> (byte * 8U));
  }
  aiden_sha256_transform(context, context->data);
  for (index = 0; index < 4U; index += 1) {
    for (uint32_t word = 0; word < 8U; word += 1) {
      digest[word * 4U + index] =
          (uint8_t)(context->state[word] >> (24U - index * 8U));
    }
  }
  return 1;
}

static inline unsigned char *CC_SHA256(
    const void *input, CC_LONG length,
    unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context;
  return CC_SHA256_Init(&context) == 1 &&
                 CC_SHA256_Update(&context, input, length) == 1 &&
                 CC_SHA256_Final(digest, &context) == 1
             ? digest
             : NULL;
}

static inline void aiden_arc4random_buf(void *output, size_t length) {
  unsigned char *cursor = output;
  while (length > 0) {
    ssize_t count = getrandom(cursor, length, 0);
    if (count > 0) {
      cursor += count;
      length -= (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    int descriptor = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) abort();
    while (length > 0) {
      count = read(descriptor, cursor, length);
      if (count > 0) {
        cursor += count;
        length -= (size_t)count;
      } else if (count < 0 && errno == EINTR) {
        continue;
      } else {
        close(descriptor);
        abort();
      }
    }
    close(descriptor);
  }
}

#define arc4random_buf aiden_arc4random_buf

static inline int aiden_renameatx_np(int old_directory, const char *old_name,
                                     int new_directory, const char *new_name,
                                     unsigned int flags) {
  unsigned int linux_flags;
  if (flags == 0x00000004U) {
    linux_flags = RENAME_NOREPLACE;
  } else if (flags == 0x00000002U) {
    linux_flags = RENAME_EXCHANGE;
  } else {
    errno = EINVAL;
    return -1;
  }
  return (int)syscall(SYS_renameat2, old_directory, old_name, new_directory,
                      new_name, linux_flags);
}

#ifndef RENAME_SWAP
#define RENAME_SWAP 0x00000002U
#endif
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004U
#endif
#define renameatx_np aiden_renameatx_np

#endif

#endif
