import * as React from "react";
import { Image, Save } from "lucide-react";
import {
  Callout,
  Field,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  toast,
} from "../ui";
import {
  announceCreateImagesAutosavePreference,
  readCreateImagesAutosaveEnabled,
  writeCreateImagesAutosaveEnabled,
} from "../../create-images/autosave-preferences-core";
import {
  readCreateImagesPowerFeatures,
  writeCreateImagesPowerFeatures,
} from "../../create-images/power-features-core";
import {
  readCreateImagesCanvasNavigationPreferences,
  writeCreateImagesCanvasNavigationPreferences,
  type CreateImagesCanvasNavigationMode,
} from "../../create-images/canvas-navigation-preferences-core";

export function CreateImagesSettings() {
  const [autosaveEnabled, setAutosaveEnabled] = React.useState(() =>
    readCreateImagesAutosaveEnabled(window.localStorage),
  );
  const [powerFeatures, setPowerFeatures] = React.useState(() =>
    readCreateImagesPowerFeatures(window.localStorage),
  );
  const [navigation, setNavigation] = React.useState(() =>
    readCreateImagesCanvasNavigationPreferences(window.localStorage),
  );

  const updateAutosave = (enabled: boolean) => {
    writeCreateImagesAutosaveEnabled(window.localStorage, enabled);
    setAutosaveEnabled(enabled);
    announceCreateImagesAutosavePreference(enabled);
  };

  const updatePowerFeatures = (enabled: boolean) => {
    writeCreateImagesPowerFeatures(window.localStorage, enabled);
    setPowerFeatures(enabled);
  };

  const updateNavigation = (
    next: ReturnType<typeof readCreateImagesCanvasNavigationPreferences>,
  ) => {
    try {
      writeCreateImagesCanvasNavigationPreferences(window.localStorage, next);
      setNavigation(next);
    } catch {
      toast.error("Aiden could not save the canvas navigation preference.");
    }
  };

  return (
    <>
      <FieldSet title="Create Images">
        <Field
          label="Autosave workflows"
          description="Save committed canvas changes on this device after a short pause. Live dragging and resizing are saved only when the gesture ends."
        >
          <Switch
            checked={autosaveEnabled}
            onCheckedChange={updateAutosave}
            aria-label="Autosave Create Images workflows"
          />
        </Field>
        {!autosaveEnabled ? (
          <div className="px-4 pb-4">
            <Callout>
              <div className="flex items-start gap-2.5">
                <Save
                  className="mt-0.5 size-4 shrink-0 text-secondary"
                  aria-hidden="true"
                />
                <div>
                  <Text variant="small-strong">Manual save is on</Text>
                  <Text
                    as="p"
                    variant="small"
                    color="secondary"
                    className="mt-1"
                  >
                    Use Save in the workflow toolbar. Starting a run also saves
                    its exact graph before Aiden opens the run review.
                  </Text>
                </div>
              </div>
            </Callout>
          </div>
        ) : null}
        <Field
          label="Power features"
          description="Reveal annotations, groups, prompt lists, pause checkpoints, and assisted workflow controls. Existing workflows keep their required controls visible."
        >
          <Switch
            checked={powerFeatures}
            onCheckedChange={updatePowerFeatures}
            aria-label="Show Create Images power features"
          />
        </Field>
      </FieldSet>

      <FieldSet title="Canvas navigation">
        <Field
          label="Navigation style"
          description="Choose how dragging, scrolling, and selection behave on the image workflow canvas."
        >
          <Select
            value={navigation.mode}
            onValueChange={(mode) =>
              updateNavigation({
                ...navigation,
                mode: mode as CreateImagesCanvasNavigationMode,
              })
            }
          >
            <SelectTrigger
              className="w-[15rem]"
              aria-label="Create Images navigation style"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="classic">Classic</SelectItem>
              <SelectItem value="trackpad">Trackpad</SelectItem>
              <SelectItem value="selection">Selection first</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Double-click to zoom"
          description="Zoom toward an empty point when you double-click the canvas. Double-clicking a node still uses its contextual action."
        >
          <Switch
            checked={navigation.zoomOnDoubleClick}
            onCheckedChange={(zoomOnDoubleClick) =>
              updateNavigation({ ...navigation, zoomOnDoubleClick })
            }
            aria-label="Double-click Create Images canvas to zoom"
          />
        </Field>
      </FieldSet>

      <Callout className="mt-5">
        <div className="flex items-start gap-2.5">
          <Image
            className="mt-0.5 size-4 shrink-0 text-secondary"
            aria-hidden="true"
          />
          <Text as="p" variant="small" color="secondary">
            These preferences stay on this device. They change editing controls,
            not workflow execution, provider consent, retained run history, or
            image ownership.
          </Text>
        </div>
      </Callout>
    </>
  );
}
