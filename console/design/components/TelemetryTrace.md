# TelemetryTrace

A telemetry trace is one metric over time in a display well, with its budget or limit drawn as a dashed `failed` line.

## Use

Run detail (D3) stacks three traces sharing one time axis: token burn, cost, tool calls. The pager uses bullet bars instead.

## Rules

- Bars in `running`; the current value in `readout-trace` at top right.
- The limit line is dashed `failed`. If the value crosses it, the bars past the line turn `blocked`.
- Time labels at both ends in `label` caps.
- The consumer provides the series, the limit and the time window.
