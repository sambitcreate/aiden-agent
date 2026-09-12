/* Test-only D-Bus portal fixture; never bundled in application packages. */
#include <gio/gio.h>
#include <stdio.h>
#include <string.h>
#define ROOT "/org/freedesktop/portal/desktop"
#define IFACE "org.freedesktop.portal.GlobalShortcuts"
static GDBusConnection *bus;
static char *session, *request, *client;
static const char *mode;
static gboolean creating;
static GMainLoop *loop;
static guint registration;
static const char xml[] =
"<node><interface name='org.freedesktop.portal.GlobalShortcuts'>"
"<method name='CreateSession'><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
"<method name='BindShortcuts'><arg type='o' direction='in'/><arg type='a(sa{sv})' direction='in'/><arg type='s' direction='in'/><arg type='a{sv}' direction='in'/><arg type='o' direction='out'/></method>"
"</interface><interface name='org.freedesktop.portal.Session'><method name='Close'/></interface></node>";
static void emit_event(const char *signal, const char *target, const char *id) {
  GVariantBuilder values; g_variant_builder_init(&values, G_VARIANT_TYPE_VARDICT);
  g_dbus_connection_emit_signal(bus, client, ROOT, IFACE, signal,
    g_variant_new("(ost@a{sv})", target, id, (guint64)1, g_variant_builder_end(&values)), NULL);
}
static gboolean finish_events(gpointer data) {
  (void)data;
  if (!strcmp(mode, "shortcuts-changed")) {
    GVariantBuilder shortcuts; g_variant_builder_init(&shortcuts, G_VARIANT_TYPE("a(sa{sv})"));
    g_dbus_connection_emit_signal(bus, client, ROOT, IFACE, "ShortcutsChanged", g_variant_new("(o@a(sa{sv}))", session, g_variant_builder_end(&shortcuts)), NULL);
  } else if (!strcmp(mode, "owner-lost")) {
    g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReleaseName", g_variant_new("(s)", "org.freedesktop.portal.Desktop"), NULL, G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL);
  } else {
    GVariantBuilder values; g_variant_builder_init(&values, G_VARIANT_TYPE_VARDICT);
    g_dbus_connection_emit_signal(bus, client, session, "org.freedesktop.portal.Session", "Closed", g_variant_new("(@a{sv})", g_variant_builder_end(&values)), NULL);
  }
  return G_SOURCE_REMOVE;
}
static gboolean events(gpointer data) {
  (void)data;
  GDBusConnection *spoof = g_dbus_connection_new_for_address_sync(g_getenv("DBUS_SESSION_BUS_ADDRESS"),
    G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION, NULL, NULL, NULL);
  if (spoof) {
    GVariantBuilder values; g_variant_builder_init(&values, G_VARIANT_TYPE_VARDICT);
    g_dbus_connection_emit_signal(spoof, client, ROOT, IFACE, "Activated",
      g_variant_new("(ost@a{sv})", session, "dictation", (guint64)1, g_variant_builder_end(&values)), NULL);
    g_dbus_connection_flush_sync(spoof, NULL, NULL); g_dbus_connection_close_sync(spoof, NULL, NULL); g_object_unref(spoof);
  }
  emit_event("Activated", ROOT "/session/stale/other", "dictation");
  emit_event("Activated", session, "wrong-id");
  emit_event("Deactivated", session, "dictation");
  emit_event("Activated", session, "dictation");
  emit_event("Activated", session, "dictation");
  emit_event("Deactivated", session, "dictation");
  emit_event("Deactivated", session, "dictation");
  if (strcmp(mode, "await-close") && strcmp(mode, "await-terminate")) g_timeout_add(30, finish_events, NULL);
  return G_SOURCE_REMOVE;
}
static gboolean respond(gpointer data) {
  (void)data;
  GVariantBuilder values; g_variant_builder_init(&values, G_VARIANT_TYPE_VARDICT);
  guint status = 0;
  if (creating) {
    g_variant_builder_add(&values, "{sv}", "session_handle", g_variant_new_string(!strcmp(mode, "wrong-session") ? ROOT "/session/wrong/path" : session));
  } else {
    if (!strcmp(mode, "cancelled")) status = 1;
    GVariantBuilder shortcuts, properties;
    g_variant_builder_init(&shortcuts, G_VARIANT_TYPE("a(sa{sv})"));
    g_variant_builder_init(&properties, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&properties, "{sv}", "trigger_description", g_variant_new_string("Ctrl+\"D\""));
    if (strcmp(mode, "absent-binding")) g_variant_builder_add(&shortcuts, "(s@a{sv})", "dictation", g_variant_builder_end(&properties));
    else g_variant_builder_clear(&properties);
    g_variant_builder_add(&values, "{sv}", "shortcuts", g_variant_builder_end(&shortcuts));
  }
  g_dbus_connection_emit_signal(bus, client, request, "org.freedesktop.portal.Request", "Response",
    g_variant_new("(u@a{sv})", status, g_variant_builder_end(&values)), NULL);
  if (!creating && status == 0 && strcmp(mode, "absent-binding")) g_timeout_add(30, events, NULL);
  return G_SOURCE_REMOVE;
}
static void method(GDBusConnection *connection, const gchar *sender, const gchar *object,
  const gchar *interface, const gchar *name, GVariant *parameters, GDBusMethodInvocation *invocation, gpointer data) {
  (void)connection; (void)object; (void)interface; (void)data;
  if (!strcmp(name, "Close")) { puts("closed"); fflush(stdout); g_dbus_method_invocation_return_value(invocation, NULL); return; }
  GVariant *options;
  creating = !strcmp(name, "CreateSession");
  if (creating) g_variant_get(parameters, "(@a{sv})", &options);
  else { const char *target, *parent; GVariant *shortcuts; g_variant_get(parameters, "(&o@a(sa{sv})&s@a{sv})", &target, &shortcuts, &parent, &options); g_variant_unref(shortcuts); }
  const char *handle, *session_token;
  g_variant_lookup(options, "handle_token", "&s", &handle);
  char *component = g_strdup(sender + 1); for (char *p = component; *p; ++p) if (*p == '.') *p = '_';
  g_free(request); request = g_strdup_printf(ROOT "/request/%s/%s", component, handle);
  if (creating) {
    g_variant_lookup(options, "session_handle_token", "&s", &session_token);
    g_free(session); session = g_strdup_printf(ROOT "/session/%s/%s", component, session_token);
    g_free(client); client = g_strdup(sender);
    if (registration) g_dbus_connection_unregister_object(bus, registration);
    GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(xml, NULL);
    static const GDBusInterfaceVTable vtable = { .method_call = method };
    registration = g_dbus_connection_register_object(bus, session, info->interfaces[1], &vtable, NULL, NULL, NULL);
    g_dbus_node_info_unref(info);
  }
  g_dbus_method_invocation_return_value(invocation, g_variant_new("(o)", request));
  g_variant_unref(options); g_free(component);
  g_idle_add(respond, NULL);
}
int main(int argc, char **argv) {
  mode = argc > 1 ? argv[1] : "success";
  bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
  if (!bus) return 1;
  GDBusNodeInfo *info = g_dbus_node_info_new_for_xml(xml, NULL);
  static const GDBusInterfaceVTable vtable = { .method_call = method };
  g_dbus_connection_register_object(bus, ROOT, info->interfaces[0], &vtable, NULL, NULL, NULL);
  GVariant *reply = g_dbus_connection_call_sync(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", "org.freedesktop.portal.Desktop", 0), NULL, G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL);
  if (!reply) return 2;
  puts("ready"); fflush(stdout);
  loop = g_main_loop_new(NULL, FALSE); g_main_loop_run(loop);
  return 0;
}
