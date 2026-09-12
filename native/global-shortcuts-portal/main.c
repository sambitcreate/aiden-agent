#define _GNU_SOURCE
#include <gio/gio.h>
#include <glib-unix.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

/* Launched only for an explicit user bind action. No startup registration. */
#define PORTAL "org.freedesktop.portal.Desktop"
#define ROOT "/org/freedesktop/portal/desktop"
#define SHORTCUTS "org.freedesktop.portal.GlobalShortcuts"
#define REQUEST "org.freedesktop.portal.Request"
#define SESSION "org.freedesktop.portal.Session"
static GDBusConnection *bus;
static GMainLoop *loop;
static char *owner, *request_path, *session_path, *sender_component;
static const char *preferred;
static gboolean bound, active, finishing, waiting_create = TRUE;
static guint deadline;
static int exit_status;

static void output(const char *line) {
  size_t length = strlen(line);
  if (length > 2048 || write(STDOUT_FILENO, line, length) != (ssize_t)length) {
    exit_status = 2;
    if (loop) g_main_loop_quit(loop);
  }
}
static void finish(const char *code) {
  if (finishing) return;
  finishing = TRUE;
  exit_status = code ? 2 : 0;
  if (code) {
    char line[128];
    g_snprintf(line, sizeof(line), "{\"type\":\"error\",\"code\":\"%s\"}\n", code);
    output(line);
  } else output("{\"type\":\"closed\"}\n");
  if (loop) g_main_loop_quit(loop);
}
static gboolean expired(gpointer data) { (void)data; deadline = 0; finish("timeout"); return G_SOURCE_REMOVE; }
static gboolean terminated(gpointer data) { (void)data; finish(NULL); return G_SOURCE_REMOVE; }
static gboolean stdin_ready(gint fd, GIOCondition condition, gpointer data) {
  (void)data;
  char bytes[64];
  if ((condition & (G_IO_HUP | G_IO_ERR)) || read(fd, bytes, sizeof(bytes)) <= 0) finish(NULL);
  else finish("protocol");
  return G_SOURCE_REMOVE;
}
static char *token(void) {
  char *value = g_uuid_string_random();
  for (char *p = value; *p; ++p) if (*p == '-') *p = '_';
  return value;
}
static GVariant *options(const char *handle, const char *session) {
  GVariantBuilder b;
  g_variant_builder_init(&b, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&b, "{sv}", "handle_token", g_variant_new_string(handle));
  if (session) g_variant_builder_add(&b, "{sv}", "session_handle_token", g_variant_new_string(session));
  return g_variant_builder_end(&b);
}
static gboolean call_request(const char *method, GVariant *parameters, const char *handle) {
  g_free(request_path);
  request_path = g_strdup_printf(ROOT "/request/%s/%s", sender_component, handle);
  GError *error = NULL;
  GVariant *reply = g_dbus_connection_call_sync(bus, owner, ROOT, SHORTCUTS, method, parameters,
    G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 10000, NULL, &error);
  if (!reply || error) { g_clear_error(&error); if (reply) g_variant_unref(reply); finish("unavailable"); return FALSE; }
  const char *returned;
  g_variant_get(reply, "(&o)", &returned);
  gboolean valid = strcmp(returned, request_path) == 0;
  g_variant_unref(reply);
  if (!valid) finish("protocol");
  return valid;
}
static void bind_shortcut(void) {
  GVariantBuilder shortcuts, properties;
  g_variant_builder_init(&shortcuts, G_VARIANT_TYPE("a(sa{sv})"));
  g_variant_builder_init(&properties, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&properties, "{sv}", "description", g_variant_new_string("Hold to dictate in Aiden"));
  if (preferred && *preferred) g_variant_builder_add(&properties, "{sv}", "preferred_trigger", g_variant_new_string(preferred));
  g_variant_builder_add(&shortcuts, "(s@a{sv})", "dictation", g_variant_builder_end(&properties));
  char *handle = token();
  call_request("BindShortcuts", g_variant_new("(o@a(sa{sv})s@a{sv})", session_path,
    g_variant_builder_end(&shortcuts), "", options(handle, NULL)), handle);
  g_free(handle);
}
static void emit_bound(const char *description) {
  GString *line = g_string_new("{\"type\":\"bound\",\"triggerDescription\":\"");
  for (const unsigned char *p = (const unsigned char *)description; *p; ++p) {
    if (*p == '"' || *p == '\\') g_string_append_c(line, '\\');
    if (*p < 0x20) g_string_append_printf(line, "\\u%04x", *p);
    else g_string_append_c(line, (char)*p);
  }
  g_string_append(line, "\"}\n"); output(line->str); g_string_free(line, TRUE);
}
static void response(GDBusConnection *connection, const gchar *sender, const gchar *object,
  const gchar *interface, const gchar *signal, GVariant *parameters, gpointer data) {
  (void)connection; (void)interface; (void)signal; (void)data;
  if (finishing || !request_path || strcmp(sender, owner) || strcmp(object, request_path)) return;
  if (!g_variant_is_of_type(parameters, G_VARIANT_TYPE("(ua{sv})"))) { finish("protocol"); return; }
  guint result; GVariant *values;
  g_variant_get(parameters, "(u@a{sv})", &result, &values);
  if (result != 0) { g_variant_unref(values); finish(result == 1 ? "cancelled" : "unavailable"); return; }
  if (waiting_create) {
    const char *created = NULL;
    if (!g_variant_lookup(values, "session_handle", "&s", &created) || strcmp(created, session_path)) {
      g_variant_unref(values); finish("protocol"); return;
    }
    waiting_create = FALSE;
    g_variant_unref(values); bind_shortcut(); return;
  }
  GVariant *shortcuts = g_variant_lookup_value(values, "shortcuts", G_VARIANT_TYPE("a(sa{sv})"));
  if (!shortcuts || g_variant_n_children(shortcuts) != 1) {
    if (shortcuts) g_variant_unref(shortcuts);
    g_variant_unref(values); finish("cancelled"); return;
  }
  const char *id; GVariant *properties;
  g_variant_get_child(shortcuts, 0, "(&s@a{sv})", &id, &properties);
  const char *description = "Desktop shortcut";
  g_variant_lookup(properties, "trigger_description", "&s", &description);
  if (strcmp(id, "dictation") || strlen(description) > 256 || !g_utf8_validate(description, -1, NULL)) finish("protocol");
  else { bound = TRUE; emit_bound(description); g_clear_pointer(&request_path, g_free); if (deadline) { g_source_remove(deadline); deadline = 0; } }
  g_variant_unref(properties); g_variant_unref(shortcuts); g_variant_unref(values);

}
static void shortcut_event(GDBusConnection *connection, const gchar *sender, const gchar *object,
  const gchar *interface, const gchar *signal, GVariant *parameters, gpointer data) {
  (void)connection; (void)object; (void)interface; (void)data;
  if (!bound || finishing || strcmp(sender, owner)) return;
  if (!g_variant_is_of_type(parameters, G_VARIANT_TYPE("(osta{sv})"))) { finish("protocol"); return; }
  const char *session, *id; guint64 timestamp; GVariant *values;
  g_variant_get(parameters, "(&o&st@a{sv})", &session, &id, &timestamp, &values);
  (void)timestamp;
  if (!strcmp(session, session_path) && !strcmp(id, "dictation")) {
    if (!strcmp(signal, "Activated") && !active) { active = TRUE; output("{\"type\":\"activated\"}\n"); }
    else if (!strcmp(signal, "Deactivated") && active) { active = FALSE; output("{\"type\":\"deactivated\"}\n"); }
  }
  g_variant_unref(values);
}
static void shortcuts_changed(GDBusConnection *connection, const gchar *sender, const gchar *object,
  const gchar *interface, const gchar *signal, GVariant *parameters, gpointer data) {
  (void)connection; (void)object; (void)interface; (void)signal; (void)data;
  if (!bound || finishing || strcmp(sender, owner)) return;
  if (!g_variant_is_of_type(parameters, G_VARIANT_TYPE("(oa(sa{sv}))"))) { finish("protocol"); return; }
  const char *session;
  g_variant_get_child(parameters, 0, "&o", &session);
  // A desktop-side edit invalidates the displayed chord and the hold state.
  // Rebinding requires another explicit user action rather than a hidden prompt.
  if (!strcmp(session, session_path)) finish("unavailable");
}
static void session_closed(GDBusConnection *connection, const gchar *sender, const gchar *object,
  const gchar *interface, const gchar *signal, GVariant *parameters, gpointer data) {
  (void)connection; (void)interface; (void)signal; (void)parameters; (void)data;
  if (!strcmp(sender, owner) && !strcmp(object, session_path)) finish(NULL);
}
static void owner_changed(GDBusConnection *connection, const gchar *sender, const gchar *object,
  const gchar *interface, const gchar *signal, GVariant *parameters, gpointer data) {
  (void)connection; (void)sender; (void)object; (void)interface; (void)signal; (void)data;
  const char *name, *old_owner, *new_owner;
  g_variant_get(parameters, "(&s&s&s)", &name, &old_owner, &new_owner);
  if (!strcmp(name, PORTAL) && !strcmp(old_owner, owner) && strcmp(new_owner, owner)) finish("unavailable");
}
static void connection_closed(GDBusConnection *connection, gboolean remote, GError *error, gpointer data) {
  (void)connection; (void)remote; (void)error; (void)data; finish("unavailable");
}
int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc < 2 || argc > 3 || strcmp(argv[1], "bind")) return 6;
  if (argc == 3) {
    if (strlen(argv[2]) > 128) return 6;
    for (const unsigned char *p = (const unsigned char *)argv[2]; *p; ++p) if (*p < 0x20 || *p > 0x7e) return 6;
    preferred = argv[2];
  }
  fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK);
  GError *error = NULL;
  bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
  if (!bus) { g_clear_error(&error); finish("unavailable"); return exit_status; }
  g_dbus_connection_set_exit_on_close(bus, FALSE);
  GVariant *started = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "StartServiceByName", g_variant_new("(su)", PORTAL, 0), G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, 10000, NULL, NULL);
  if (started) g_variant_unref(started);
  GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner", g_variant_new("(s)", PORTAL), G_VARIANT_TYPE("(s)"), G_DBUS_CALL_FLAGS_NONE, 5000, NULL, &error);
  if (!reply) { g_clear_error(&error); finish("unavailable"); g_object_unref(bus); return exit_status; }
  g_variant_get(reply, "(s)", &owner); g_variant_unref(reply);
  sender_component = g_strdup(g_dbus_connection_get_unique_name(bus) + 1);
  for (char *p = sender_component; *p; ++p) if (*p == '.') *p = '_';
  char *session_token = token(), *handle = token();
  session_path = g_strdup_printf(ROOT "/session/%s/%s", sender_component, session_token);
  loop = g_main_loop_new(NULL, FALSE);
  g_dbus_connection_signal_subscribe(bus, owner, REQUEST, "Response", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE, response, NULL, NULL);
  g_dbus_connection_signal_subscribe(bus, owner, SHORTCUTS, "Activated", ROOT, NULL, G_DBUS_SIGNAL_FLAGS_NONE, shortcut_event, NULL, NULL);
  g_dbus_connection_signal_subscribe(bus, owner, SHORTCUTS, "Deactivated", ROOT, NULL, G_DBUS_SIGNAL_FLAGS_NONE, shortcut_event, NULL, NULL);
  g_dbus_connection_signal_subscribe(bus, owner, SHORTCUTS, "ShortcutsChanged", ROOT, NULL, G_DBUS_SIGNAL_FLAGS_NONE, shortcuts_changed, NULL, NULL);
  g_dbus_connection_signal_subscribe(bus, owner, SESSION, "Closed", session_path, NULL, G_DBUS_SIGNAL_FLAGS_NONE, session_closed, NULL, NULL);
  g_dbus_connection_signal_subscribe(bus, "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", "/org/freedesktop/DBus", PORTAL, G_DBUS_SIGNAL_FLAGS_NONE, owner_changed, NULL, NULL);
  g_signal_connect(bus, "closed", G_CALLBACK(connection_closed), NULL);
  g_unix_signal_add(SIGTERM, terminated, NULL); g_unix_signal_add(SIGINT, terminated, NULL);
  g_unix_fd_add(STDIN_FILENO, G_IO_IN | G_IO_HUP | G_IO_ERR, stdin_ready, NULL);
  deadline = g_timeout_add_seconds(120, expired, NULL);
  if (call_request("CreateSession", g_variant_new("(@a{sv})", options(handle, session_token)), handle)) g_main_loop_run(loop);
  if (request_path) g_dbus_connection_call(bus, owner, request_path, REQUEST, "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL, NULL);
  if (session_path) g_dbus_connection_call(bus, owner, session_path, SESSION, "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL, NULL);
  g_dbus_connection_flush_sync(bus, NULL, NULL);
  g_free(session_token); g_free(handle); g_free(owner); g_free(sender_component); g_free(session_path); g_free(request_path);
  g_main_loop_unref(loop); g_object_unref(bus);
  return exit_status;
}
