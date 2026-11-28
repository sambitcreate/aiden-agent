#ifndef AIDEN_IDENTITY_H
#define AIDEN_IDENTITY_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static inline int aiden_same_timestamp(struct timespec left,
                                       struct timespec right) {
  return left.tv_sec == right.tv_sec && left.tv_nsec == right.tv_nsec;
}

static inline int aiden_exclusive_regular(const struct stat *identity) {
  return S_ISREG(identity->st_mode) && identity->st_nlink == 1;
}

static inline int aiden_base64_value(unsigned char value) {
  if (value >= 'A' && value <= 'Z')
    return value - 'A';
  if (value >= 'a' && value <= 'z')
    return value - 'a' + 26;
  if (value >= '0' && value <= '9')
    return value - '0' + 52;
  if (value == '+')
    return 62;
  if (value == '/')
    return 63;
  return -1;
}

static inline void aiden_random_uuid(char output[37]) {
  static const char hex[] = "0123456789abcdef";
  uint8_t bytes[16];
  arc4random_buf(bytes, sizeof(bytes));
  bytes[6] = (uint8_t)((bytes[6] & 0x0f) | 0x40);
  bytes[8] = (uint8_t)((bytes[8] & 0x3f) | 0x80);
  size_t output_index = 0;
  for (size_t byte_index = 0; byte_index < sizeof(bytes); byte_index += 1) {
    if (output_index == 8 || output_index == 13 || output_index == 18 ||
        output_index == 23) {
      output[output_index++] = '-';
    }
    output[output_index++] = hex[bytes[byte_index] >> 4];
    output[output_index++] = hex[bytes[byte_index] & 0x0f];
  }
  output[36] = '\0';
}

static inline void aiden_hex_digest(const unsigned char digest[32],
                                    char output[65]) {
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < 32; index += 1) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 0x0f];
  }
  output[64] = '\0';
}

static inline int aiden_valid_hex_digest(const char *value) {
  if (value == NULL || strlen(value) != 64)
    return 0;
  for (size_t index = 0; index < 64; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f')))
      return 0;
  }
  return 1;
}

#endif
