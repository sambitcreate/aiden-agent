import { Loader2 } from "lucide-react";
import { Field, Switch } from "../ui";

/** The Remote Access row that lets other desktops ask to control this one. */
export function AcceptConnectionRequestsField({
  accept,
  hostLabel,
  busy,
  disabled,
  onChange,
}: {
  accept: boolean;
  hostLabel: string;
  busy: boolean;
  disabled: boolean;
  onChange: (accept: boolean) => void;
}) {
  return (
    <Field
      label="Accept connection requests"
      description={`Other computers running Aiden can ask to control this ${hostLabel}. You compare a code and approve each request here.`}
    >
      <div className="flex items-center justify-end gap-2">
        {busy ? <Loader2 className="size-4 animate-spin text-secondary" aria-hidden="true" /> : null}
        <Switch
          checked={accept}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-label="Accept connection requests"
        />
      </div>
    </Field>
  );
}
