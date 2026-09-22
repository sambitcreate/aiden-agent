function inspectElectronConsoleMessage(args) {
  const modern =
    args[0] && typeof args[0] === "object" && "level" in args[0] && "message" in args[0]
      ? args[0]
      : null;
  const legacyDetails =
    args[1] && typeof args[1] === "object" && "level" in args[1] && "message" in args[1]
      ? args[1]
      : null;
  const structured = modern ?? legacyDetails;
  const level = structured?.level ?? args[1];
  const message = String(structured?.message ?? args[2] ?? "");
  return {
    message,
    isError:
      level === 3 ||
      level === "error" ||
      /content security policy|refused to|uncaught|error/iu.test(message),
  };
}

module.exports = { inspectElectronConsoleMessage };
