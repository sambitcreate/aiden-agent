import {
  CREATE_IMAGES_MAX_PROMPT_LENGTH,
  type CreateImagesPromptVariable,
} from "./schema.js";

export type CreateImagesPromptResolution =
  | { status: "ready"; text: string }
  | { status: "invalid"; message: string };

/** Resolve bounded named tokens. `\${name}` emits a literal `${name}`. */
export function resolveCreateImagesPromptVariables(
  template: string,
  variables: readonly CreateImagesPromptVariable[],
  valuesById: Readonly<Record<string, string | undefined>>,
): CreateImagesPromptResolution {
  const byName = new Map(variables.map((variable) => [variable.name, variable]));
  for (const variable of variables) {
    const value = valuesById[variable.id];
    if (variable.required && (!value || value.trim().length === 0)) {
      return { status: "invalid", message: `Prompt variable "${variable.name}" requires a value.` };
    }
  }
  const escaped: string[] = [];
  const protectedTemplate = template.replace(/\\\$\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu, (_match, name: string) => {
    const index = escaped.push(`\${${name}}`) - 1;
    return `\uE000AIDEN_LITERAL_${index}\uE000`;
  });
  let invalidName: string | undefined;
  const resolved = protectedTemplate.replace(/\$\{([A-Za-z][A-Za-z0-9_]{0,31})\}/gu, (_match, name: string) => {
    const variable = byName.get(name);
    if (!variable) {
      invalidName = name;
      return "";
    }
    return valuesById[variable.id] ?? "";
  });
  if (invalidName) {
    return { status: "invalid", message: `Prompt token "${invalidName}" has no declared variable.` };
  }
  const restored = resolved.replace(
    /\uE000AIDEN_LITERAL_(\d+)\uE000/gu,
    (_match, rawIndex: string) => escaped[Number(rawIndex)] ?? "",
  );
  if (restored.length > CREATE_IMAGES_MAX_PROMPT_LENGTH) {
    return { status: "invalid", message: "The resolved prompt exceeds the prompt length limit." };
  }
  return { status: "ready", text: restored };
}
