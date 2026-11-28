import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  Button,
  Command,
  CommandInput,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Textarea,
} from "./ui";
import {
  Checkbox,
  DataTable,
  Disclosure,
  Kbd,
  Progress,
  Segmented,
  Slider,
  Stat,
  Tabs,
} from "./ui-primitives";

afterEach(() => cleanup());

function Controlled<T>({ initial, children }: { initial: T; children: (value: T, set: (next: T) => void) => React.ReactNode }) {
  const [value, setValue] = React.useState(initial);
  return <>{children(value, setValue)}</>;
}

test("Segmented is a labelled single-choice group that follows arrow keys", async () => {
  const changes: string[] = [];
  render(
    <Controlled initial="all">
      {(value, set) => (
        <Segmented
          aria-label="Filter tasks"
          value={value}
          onValueChange={(next) => {
            changes.push(next);
            set(next);
          }}
          options={[
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "paused", label: "Paused" },
          ]}
        />
      )}
    </Controlled>,
  );
  const group = screen.getByRole("radiogroup", { name: "Filter tasks" });
  assert.ok(group);
  const all = screen.getByRole("radio", { name: "All" });
  assert.equal(all.getAttribute("aria-checked"), "true");
  act(() => all.focus());
  fireEvent.keyDown(all, { key: "ArrowRight" });
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("radio", { name: "Active" }), "focus moves to Active"));
  fireEvent.click(screen.getByRole("radio", { name: "Paused" }));
  assert.equal(changes[changes.length - 1], "paused");
  assert.equal(screen.getByRole("radio", { name: "Paused" }).getAttribute("aria-checked"), "true");
});

test("Tabs exposes the selected tab and supports Home and End", async () => {
  render(
    <Controlled initial="a">
      {(value, set) => (
        <Tabs
          aria-label="Sections"
          value={value}
          onValueChange={set}
          items={[
            { value: "a", label: "Alpha" },
            { value: "b", label: "Beta" },
            { value: "c", label: "Gamma" },
          ]}
        />
      )}
    </Controlled>,
  );
  const alpha = screen.getByRole("tab", { name: "Alpha" });
  assert.equal(alpha.getAttribute("aria-selected"), "true");
  act(() => alpha.focus());
  fireEvent.keyDown(alpha, { key: "End" });
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("tab", { name: "Gamma" }), "End focuses the last tab"));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Beta" }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
  assert.equal(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected"), "true");
});

test("Checkbox toggles by click and is named by its label", () => {
  render(
    <Controlled initial={false}>
      {(value, set) => <Checkbox checked={value} onCheckedChange={set} label="Bill annually" />}
    </Controlled>,
  );
  const box = screen.getByRole("checkbox", { name: "Bill annually" });
  assert.equal(box.getAttribute("aria-checked"), "false");
  fireEvent.click(box);
  assert.equal(box.getAttribute("aria-checked"), "true");
});

test("Slider moves by its step from the keyboard and shows its value", () => {
  render(
    <Controlled initial={3}>
      {(value, set) => <Slider label="Rows" value={value} min={1} max={5} step={1} onValueChange={set} valueLabel={`${value} rows`} />}
    </Controlled>,
  );
  const thumb = screen.getByRole("slider", { name: "Rows" });
  assert.equal(thumb.getAttribute("aria-valuenow"), "3");
  fireEvent.keyDown(thumb, { key: "ArrowRight" });
  assert.equal(thumb.getAttribute("aria-valuenow"), "4");
  assert.ok(screen.getByText("4 rows"));
});

test("Progress is a named progressbar with its value, or indeterminate", () => {
  const view = render(<Progress label="Update download progress" value={42} />);
  const bar = screen.getByRole("progressbar", { name: "Update download progress" });
  assert.equal(bar.getAttribute("aria-valuenow"), "42");
  assert.equal(bar.getAttribute("aria-valuemax"), "100");
  view.rerender(<Progress label="Working" indeterminate />);
  assert.equal(screen.getByRole("progressbar", { name: "Working" }).hasAttribute("aria-valuenow"), false);
});

test("Disclosure toggles its content and reports its state", () => {
  render(<Disclosure title="Show the code">secret body</Disclosure>);
  const trigger = screen.getByRole("button", { name: "Show the code" });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("secret body"), null);
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.ok(screen.getByText("secret body"));
});

test("DataTable renders column headers and rows as a real table", () => {
  render(
    <DataTable
      caption="Revenue by region"
      columns={[{ key: "region", label: "Region" }, { key: "revenue", label: "Revenue", align: "end" }]}
      rows={[{ region: "EMEA", revenue: "$2,400" }, { region: "AMER", revenue: "$3,100" }]}
    />,
  );
  const table = screen.getByRole("table", { name: "Revenue by region" });
  assert.ok(table);
  assert.deepEqual(screen.getAllByRole("columnheader").map((cell) => cell.textContent), ["Region", "Revenue"]);
  assert.equal(screen.getAllByRole("row").length, 3);
});

test("Stat and Kbd present their content accessibly", () => {
  render(
    <>
      <Stat label="Total" value="$6,930" trend={0.12} caption="vs Q2" />
      <Kbd>⌘K</Kbd>
    </>,
  );
  assert.ok(screen.getByText("$6,930"));
  assert.ok(screen.getByText("Total"));
  assert.ok(screen.getByText(/12%/u));
  assert.equal(screen.getByText("⌘K").tagName, "KBD");
});

test("shared UI primitives attach direct React 19 refs and compose Radix asChild triggers", async () => {
  const buttonRef = React.createRef<HTMLButtonElement>();
  const linkRef = React.createRef<HTMLAnchorElement>();
  const menuTriggerRef = React.createRef<HTMLButtonElement>();
  const inputRef = React.createRef<HTMLInputElement>();
  const textareaRef = React.createRef<HTMLTextAreaElement>();
  const separatorRef = React.createRef<HTMLDivElement>();
  const labelRef = React.createRef<HTMLLabelElement>();
  const switchRef = React.createRef<HTMLButtonElement>();
  const selectTriggerRef = React.createRef<HTMLButtonElement>();
  const commandInputRef = React.createRef<HTMLInputElement>();
  let picked = false;

  render(
    <div>
      <Button ref={buttonRef}>Plain action</Button>
      <Button asChild>
        <a ref={linkRef} href="#target">
          Slotted link
        </a>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={menuTriggerRef}>Menu trigger</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => { picked = true; }}>
            First item
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Label ref={labelRef} htmlFor="name-field">Name</Label>
      <Input id="name-field" ref={inputRef} defaultValue="Ada" />
      <Textarea ref={textareaRef} aria-label="Notes" defaultValue="Hello" />
      <Separator ref={separatorRef} />
      <Switch ref={switchRef} aria-label="Notifications" />
      <Select defaultValue="one">
        <SelectTrigger ref={selectTriggerRef} aria-label="Choice">
          <SelectValue />
        </SelectTrigger>
      </Select>
      <Command>
        <CommandInput ref={commandInputRef} placeholder="Search commands" />
      </Command>
    </div>,
  );

  assert.equal(buttonRef.current, screen.getByRole("button", { name: "Plain action" }));
  assert.equal(linkRef.current, screen.getByRole("link", { name: "Slotted link" }));
  assert.equal(linkRef.current?.getAttribute("data-slot"), "button");
  const trigger = screen.getByRole("button", { name: "Menu trigger" });
  assert.equal(menuTriggerRef.current, trigger);
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  const item = await screen.findByRole("menuitem", { name: "First item" });
  fireEvent.click(item);
  assert.equal(picked, true);

  assert.equal(labelRef.current?.tagName, "LABEL");
  assert.equal(inputRef.current, screen.getByLabelText("Name"));
  assert.equal(textareaRef.current, screen.getByLabelText("Notes"));
  assert.equal(separatorRef.current?.getAttribute("data-orientation"), "horizontal");
  assert.equal(switchRef.current, screen.getByRole("switch", { name: "Notifications" }));
  assert.equal(selectTriggerRef.current, screen.getByRole("combobox", { name: "Choice" }));
  assert.equal(commandInputRef.current, screen.getByPlaceholderText("Search commands"));
});
