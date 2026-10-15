import { Button, Text } from "./ui";

/** Uses the shared provider dialog; no credentials or login requests are made on mount. */
export function OnboardingOpenAiLogin({ available, disabled, onConnect }: {
  available: boolean;
  disabled: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="space-y-2">
      <Text as="p" variant="small" color="secondary">
        Connect your ChatGPT subscription through OpenAI. Sign-in shares a random installation
        identifier with OpenAI; it does not contain your chats or workspace details.
      </Text>
      <Button disabled={disabled || !available} onClick={onConnect}>
        Sign in with OpenAI
      </Button>
    </div>
  );
}
