import { protocol, type Session } from "electron";
import {
  GENERATIVE_UI_PROTOCOL_SCHEME,
  generativeUiHostLibraryNameFromUrl,
} from "../../renderer/shared/generative-ui.js";
import { readGenerativeUiHostLibrary } from "./generative-ui-host-libraries.js";

let schemesRegistered = false;
let handlerRegistered = false;

export function registerGenerativeUiScheme(): void {
  if (schemesRegistered) return;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: GENERATIVE_UI_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: false,
        corsEnabled: false,
        stream: true,
      },
    },
  ]);
  schemesRegistered = true;
}

export function registerGenerativeUiProtocol(_session?: Session): void {
  if (handlerRegistered) return;
  protocol.handle(GENERATIVE_UI_PROTOCOL_SCHEME, async (request) => {
    const name = generativeUiHostLibraryNameFromUrl(request.url);
    const file = name ? await readGenerativeUiHostLibrary(name) : undefined;
    if (!file) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    return new Response(file.bytes, {
      status: 200,
      headers: {
        "content-type": file.mimeType,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  });
  handlerRegistered = true;
}
