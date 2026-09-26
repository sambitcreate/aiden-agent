#define _GNU_SOURCE
/* Low-level encoding keeps CreateItem noninteractive; never run prompts. */
#define SECRET_API_SUBJECT_TO_CHANGE
#include <libsecret/secret.h>
#include <stdio.h>
#include <string.h>

/* Values travel only over anonymous stdio. Never print service errors: some
 * providers include request data in their diagnostics. These statuses are the
 * complete protocol consumed by the main-process adapter. */
enum { OK = 0, UNAVAILABLE = 2, LOCKED = 3, MISSING = 4, DUPLICATE = 5, INVALID = 6 };
#define MAX_VALUE 1024
static const SecretSchema schema = {
  .name = "com.aiden.bot-authority.v1",
  .flags = SECRET_SCHEMA_NONE,
  .attributes = {{ "service", SECRET_SCHEMA_ATTRIBUTE_STRING },
                 { "account", SECRET_SCHEMA_ATTRIBUTE_STRING }, { NULL, 0 }}
};

static int valid_identity(const char *service, const char *account) {
  static const char *services[] = {
    "com.aiden.bot-capability.rollback-authority.v1",
    "com.aiden.bot-capability.bootstrap-consumed.v1",
    "com.aiden.telegram-bot-binding.rollback-authority.v1",
    "com.aiden.telegram-bot-binding.bootstrap-consumed.v1"
  };
  int allowed = 0;
  for (size_t i = 0; i < sizeof(services) / sizeof(services[0]); i++)
    if (strcmp(service, services[i]) == 0) allowed = 1;
  if (!allowed || strlen(account) != 74 || strncmp(account, "user-data:", 10) != 0) return 0;
  for (size_t i = 10; i < 74; i++)
    if (!((account[i] >= '0' && account[i] <= '9') || (account[i] >= 'a' && account[i] <= 'f'))) return 0;
  return 1;
}

static int valid_value(const char *value, size_t length) {
  return value != NULL && length > 0 && length <= MAX_VALUE &&
    memchr(value, '\0', length) == NULL && memchr(value, '\n', length) == NULL &&
    memchr(value, '\r', length) == NULL && g_utf8_validate(value, (gssize)length, NULL);
}

int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[1], "lookup") != 0 && strcmp(argv[1], "store") != 0) ||
      !valid_identity(argv[2], argv[3])) return INVALID;
  const int writing = strcmp(argv[1], "store") == 0;
  char input[MAX_VALUE + 1] = {0};
  size_t input_length = 0;
  if (writing) {
    input_length = fread(input, 1, sizeof(input), stdin);
    if (ferror(stdin) || !feof(stdin) || !valid_value(input, input_length)) return INVALID;
  }

  int status = UNAVAILABLE;
  GError *error = NULL;
  SecretService *service = secret_service_get_sync(SECRET_SERVICE_OPEN_SESSION, NULL, &error);
  if (!service || error) { g_clear_error(&error); if (service) g_object_unref(service); return status; }
  /* Check the collection before searching. An empty result from a locked
   * collection must never be mistaken for a fresh bootstrap. No unlock prompt
   * or collection creation is attempted by this helper. */
  SecretCollection *collection = secret_collection_for_alias_sync(service, SECRET_COLLECTION_DEFAULT,
    SECRET_COLLECTION_NONE, NULL, &error);
  GHashTable *attributes = NULL;
  GList *items = NULL;
  SecretValue *secret = NULL;
  if (!collection || error) goto done;
  gchar *session_path = secret_service_read_alias_dbus_path_sync(service, SECRET_COLLECTION_SESSION, NULL, &error);
  if (error) { g_free(session_path); goto done; }
  if (session_path && strcmp(session_path, g_dbus_proxy_get_object_path(G_DBUS_PROXY(collection))) == 0) {
    g_free(session_path);
    goto done;
  }
  g_free(session_path);
  if (secret_collection_get_locked(collection)) { status = LOCKED; goto done; }
  attributes = secret_attributes_build(&schema, "service", argv[2], "account", argv[3], NULL);
  /* Read and duplicate-check inside the same collection this helper writes to.
   * A stray matching item in another collection must never be served as the
   * authority, nor become a service-wide duplicate after a store. */
  items = secret_collection_search_sync(collection, &schema, attributes,
    SECRET_SEARCH_ALL | SECRET_SEARCH_LOAD_SECRETS, NULL, &error);
  if (error) goto done;
  if (g_list_length(items) > 1) { status = DUPLICATE; goto done; }
  if (items && secret_item_get_locked(SECRET_ITEM(items->data))) { status = LOCKED; goto done; }

  if (writing) {
    /* Store into the exact unlocked collection we inspected, never a newly
     * resolved alias. If the provider locks it concurrently, fail closed. */
    secret = secret_value_new(input, (gssize)input_length, "text/plain");
    GVariantBuilder attrs;
    g_variant_builder_init(&attrs, G_VARIANT_TYPE("a{ss}"));
    g_variant_builder_add(&attrs, "{ss}", "xdg:schema", schema.name);
    g_variant_builder_add(&attrs, "{ss}", "service", argv[2]);
    g_variant_builder_add(&attrs, "{ss}", "account", argv[3]);
    GVariantBuilder properties;
    g_variant_builder_init(&properties, G_VARIANT_TYPE("a{sv}"));
    g_variant_builder_add(&properties, "{sv}", "org.freedesktop.Secret.Item.Label", g_variant_new_string("Aiden Bot authority"));
    g_variant_builder_add(&properties, "{sv}", "org.freedesktop.Secret.Item.Attributes", g_variant_builder_end(&attrs));
    GVariant *encoded = secret_service_encode_dbus_secret(service, secret);
    if (!encoded) { g_variant_builder_clear(&properties); goto done; }
    GVariant *reply = g_dbus_proxy_call_sync(G_DBUS_PROXY(collection), "CreateItem",
      g_variant_new("(@a{sv}@(oayays)b)", g_variant_builder_end(&properties), encoded, TRUE),
      G_DBUS_CALL_FLAGS_NONE, 4000, NULL, &error);
    if (reply) {
      const char *item_path = NULL, *prompt_path = NULL;
      g_variant_get(reply, "(&o&o)", &item_path, &prompt_path);
      /* Unlike the convenience store API, never invoke a returned prompt. */
      status = !error && strcmp(item_path, "/") != 0 && strcmp(prompt_path, "/") == 0 ? OK : UNAVAILABLE;
      g_variant_unref(reply);
    }
  } else if (!items) {
    status = MISSING;
  } else {
    secret = secret_item_get_secret(SECRET_ITEM(items->data));
    if (!secret) goto done;
    gsize length = 0;
    const char *value = secret_value_get(secret, &length);
    if (!valid_value(value, length)) { status = INVALID; goto done; }
    status = fwrite(value, 1, length, stdout) == length && fflush(stdout) == 0 ? OK : UNAVAILABLE;
  }
done:
  explicit_bzero(input, sizeof(input));
  if (secret) secret_value_unref(secret);
  if (items) g_list_free_full(items, g_object_unref);
  if (attributes) g_hash_table_unref(attributes);
  if (collection) g_object_unref(collection);
  g_object_unref(service);
  g_clear_error(&error);
  return status;
}
