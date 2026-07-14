// tests/lib/pty-fixtures/textfield-app.jsx — minimal Ink host that
// mounts our real TextField inside a layout shaped like Zoom's composer
// (fixed-height log box above, `▸ ` prefix in a row Box with the field).
// PTY recipes drive this app to verify what an actual terminal renders
// when Ctrl+J inserts a newline — the place where in-process tests pass
// but the user still sees the cursor jumping to col 0 of the same line.

import React, { useState } from 'react';
import { render, Box, Text, useApp } from 'ink';
import TextField from '../../../tui/lib/TextField.jsx';

function App() {
  const { exit } = useApp();
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(null);

  return (
    <Box flexDirection="column" width={60}>
      <Box height={5} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>log placeholder · drive me with PTY recipes</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="cyan">▸ </Text>
        <TextField
          value={value}
          onChange={setValue}
          onSubmit={(v) => { setSubmitted(v); exit(); }}
          focus
          color="white"
          caretColor="cyan"
          width={56}
          placeholder="type then press Ctrl+J then more text"
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          submitted: {submitted == null ? '(none)' : JSON.stringify(submitted)}
        </Text>
      </Box>
    </Box>
  );
}

render(<App />);
