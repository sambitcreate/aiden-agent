import * as React from "react";
import { matchSegments, type MatchRange } from "../lib/text-match";

/** A label with the part a search matched marked in the match color. */
export function MatchText({ text, ranges }: { text: string; ranges: readonly MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  return (
    <>
      {matchSegments(text, ranges).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="bg-transparent text-match">
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  );
}
