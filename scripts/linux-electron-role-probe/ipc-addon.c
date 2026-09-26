#include "ipc.h"
#define NAPI_VERSION 8
#include <node_api.h>
static napi_value receive_endpoint(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argument; bool protected_channel = false;
  if (napi_get_cb_info(env, info, &argc, &argument, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_bool(env, argument, &protected_channel) != napi_ok) {
    napi_throw_type_error(env, NULL, "receive expects a channel boolean"); return NULL;
  }
  int transport = -1, endpoint = -1; const char *failure = "native IPC setup";
  char context[256] = {0}, server_context[256] = {0}, socket_context[256] = {0};
  struct ucred server; socklen_t server_size = sizeof(server);
  if (current_context(context, sizeof(context)) || !getuid() || geteuid() != getuid() ||
      (!strstr(context, ":aiden_electron_role_probe_main_t:") &&
       !strstr(context, ":aiden_electron_role_probe_child_t:"))) goto fail;
  int64_t deadline = now_ms() + 4000;
  transport = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (transport < 0) goto fail;
  struct sockaddr_un address = {.sun_family = AF_UNIX}; strcpy(address.sun_path, IPC_PATH);
  if (connect(transport, (struct sockaddr *)&address, sizeof(address))) {
    if (errno != EINPROGRESS || wait_io(transport, POLLOUT, deadline)) goto fail;
    int error = 0; socklen_t length = sizeof(error);
    if (getsockopt(transport, SOL_SOCKET, SO_ERROR, &error, &length) || error) goto fail;
  }
  if (getsockopt(transport, SOL_SOCKET, SO_PEERCRED, &server, &server_size) ||
      peer_context(transport, server_context, sizeof(server_context)) || server.uid != getuid() ||
      strcmp(server_context, "system_u:system_r:aiden_electron_role_probe_sender_t:s0")) goto fail;
  char channel = protected_channel ? 'P' : 'G';
  if (exact_io(transport, &channel, 1, 1, deadline)) goto fail;
  char byte = 0; struct iovec iov = {.iov_base = &byte, .iov_len = 1};
  union { struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr message = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
  ssize_t received;
  do {
    if (wait_io(transport, POLLIN, deadline)) goto fail;
    received = recvmsg(transport, &message, MSG_CMSG_CLOEXEC | MSG_DONTWAIT);
  } while (received < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK));
  if (received != 1 || byte != 'F') goto fail;
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (header) {
    if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS || header->cmsg_len < CMSG_LEN(0)) goto fail;
    size_t count = (header->cmsg_len - CMSG_LEN(0)) / sizeof(int);
    if (count != 1 || (message.msg_flags & MSG_CTRUNC)) {
      for (size_t index = 0; index < count; index++) {
        int extra; memcpy(&extra, CMSG_DATA(header) + index * sizeof(int), sizeof(extra)); close(extra);
      }
      goto fail;
    }
    memcpy(&endpoint, CMSG_DATA(header), sizeof(endpoint));
  }
  int token_read = 0, ack_written = 0;
  if (endpoint >= 0) {
    failure = "endpoint label or token read";
    char token[sizeof(IPC_TOKEN) - 1];
    if (peer_context(endpoint, socket_context, sizeof(socket_context)) ||
        exact_io(endpoint, token, sizeof(token), 0, deadline) || memcmp(token, IPC_TOKEN, sizeof(token))) goto fail;
    token_read = 1;
    failure = "endpoint ACK write";
    if (exact_io(endpoint, IPC_ACK, sizeof(IPC_ACK) - 1, 1, deadline)) goto fail;
    ack_written = 1;
  }
  failure = "transport reply";
  char reply = endpoint < 0 ? 'D' : 'A';
  if (exact_io(transport, &reply, 1, 1, deadline)) goto fail;
  char json[1800];
  int length = snprintf(json, sizeof(json), "{\"channel\":\"%s\",\"pid\":%ld,\"uid\":%lu,\"context\":\"%s\",\"serverPid\":%ld,\"serverContext\":\"%s\",\"socketContext\":\"%s\",\"receivedFd\":%s,\"truncated\":%s,\"tokenRead\":%s,\"ackWritten\":%s,\"napiVersion\":8}", protected_channel ? "protected" : "generic", (long)getpid(), (unsigned long)getuid(), context, (long)server.pid, server_context, socket_context, endpoint >= 0 ? "true" : "false", message.msg_flags & MSG_CTRUNC ? "true" : "false", token_read ? "true" : "false", ack_written ? "true" : "false");
  if (length < 0 || length >= (int)sizeof(json)) goto fail;
  close(transport); if (endpoint >= 0) close(endpoint);
  napi_value result;
  if (napi_create_string_utf8(env, json, (size_t)length, &result) != napi_ok) return NULL;
  return result;
fail:
  if (endpoint >= 0) close(endpoint);
  if (transport >= 0) close(transport);
  char error[160]; snprintf(error, sizeof(error), "%s (errno=%d)", failure, errno);
  napi_throw_error(env, NULL, error); return NULL;
}
NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "receive", NAPI_AUTO_LENGTH, receive_endpoint, NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "receive", function) != napi_ok) return NULL;
  return exports;
}
