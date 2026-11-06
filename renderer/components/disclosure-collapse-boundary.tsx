import * as React from "react";

interface Props {
  expanded: boolean;
  beforeCollapse(): void;
  afterCollapse(): void;
  children: React.ReactNode;
}

/** Capture sticky geometry before React removes the body, then restore after layout. */
export class DisclosureCollapseBoundary extends React.Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): null {
    if (previous.expanded && !this.props.expanded) this.props.beforeCollapse();
    return null;
  }
  componentDidUpdate(previous: Props): void {
    if (previous.expanded && !this.props.expanded) this.props.afterCollapse();
  }
  render(): React.ReactNode {
    return this.props.children;
  }
}
