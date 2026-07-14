// tests/lib/pty-fixtures/counter-app.jsx — minimal Ink app used as a
// deterministic target for PTY recipes. Renders a counter, accepts a few
// key bindings, and exits cleanly on `q`. Keep this small so the recipes
// it backs are self-explanatory: the assertion is about the runner, not
// the app.

import React, { useState } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';

function App() {
  const [count, setCount] = useState(0);
  const { exit } = useApp();

  useInput((input) => {
    if (input === '+') setCount((c) => c + 1);
    if (input === '-') setCount((c) => c - 1);
    if (input === '0') setCount(0);
    if (input === 'q') exit();
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text>counter: </Text>
        <Text bold>{count}</Text>
      </Box>
      <Box>
        <Text dimColor>+ inc · - dec · 0 reset · q quit</Text>
      </Box>
    </Box>
  );
}

render(<App />);
