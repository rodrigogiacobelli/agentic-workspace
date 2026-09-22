// The built-in themes. One object drives the chrome (CSS variables), the
// terminal palette and the syntax colours, so every surface changes together.

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  ui: {
    bg: string; bgRaised: string; bgHover: string;
    fg: string; fgDim: string; fgFaint: string;
    border: string; accent: string; selection: string; danger: string;
    codeBg: string;
  };
  terminal: {
    background: string; foreground: string; cursor: string; selectionBackground: string;
    black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
    brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
  };
  syntax: {
    keyword: string; string: string; number: string; comment: string; property: string;
    tag: string; attribute: string; heading: string; link: string; emphasis: string; punctuation: string; meta: string;
  };
}

export const themes: Theme[] = [
  {
    id: "graphite", name: "Graphite (dark)", dark: true,
    ui: { bg: "#14171c", bgRaised: "#1b1f26", bgHover: "#232833", fg: "#d6dbe3", fgDim: "#7b8393", fgFaint: "#4d5462", border: "#2a303b", accent: "#7dd3fc", selection: "#2e4a6b", danger: "#f87171", codeBg: "#1b1f26" },
    terminal: { background: "#14171c", foreground: "#d6dbe3", cursor: "#7dd3fc", selectionBackground: "#2e4a6b", black: "#1c2027", red: "#f87171", green: "#86efac", yellow: "#fcd34d", blue: "#7aa2f7", magenta: "#c4a7e7", cyan: "#7dd3fc", white: "#d6dbe3", brightBlack: "#5b6270", brightRed: "#fca5a5", brightGreen: "#bbf7d0", brightYellow: "#fde68a", brightBlue: "#a5c0ff", brightMagenta: "#e0cffc", brightCyan: "#bae6fd", brightWhite: "#f3f4f6" },
    syntax: { keyword: "#c4a7e7", string: "#86efac", number: "#fcd34d", comment: "#5b6270", property: "#7aa2f7", tag: "#f87171", attribute: "#fcd34d", heading: "#7dd3fc", link: "#7aa2f7", emphasis: "#e0cffc", punctuation: "#7b8393", meta: "#7b8393" },
  },
  {
    id: "nord", name: "Nord (dark)", dark: true,
    ui: { bg: "#2e3440", bgRaised: "#3b4252", bgHover: "#434c5e", fg: "#e5e9f0", fgDim: "#9aa5b8", fgFaint: "#6b7590", border: "#4c566a", accent: "#88c0d0", selection: "#4c566a", danger: "#bf616a", codeBg: "#3b4252" },
    terminal: { background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", selectionBackground: "#434c5e", black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0", brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4" },
    syntax: { keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", comment: "#616e88", property: "#88c0d0", tag: "#81a1c1", attribute: "#8fbcbb", heading: "#88c0d0", link: "#5e81ac", emphasis: "#ebcb8b", punctuation: "#9aa5b8", meta: "#9aa5b8" },
  },
  {
    id: "solarized-light", name: "Solarized (light)", dark: false,
    ui: { bg: "#fdf6e3", bgRaised: "#eee8d5", bgHover: "#e6dfc8", fg: "#586e75", fgDim: "#93a1a1", fgFaint: "#b8c0c0", border: "#d9d2bc", accent: "#268bd2", selection: "#d5ceb6", danger: "#dc322f", codeBg: "#eee8d5" },
    terminal: { background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75", selectionBackground: "#eee8d5", black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5", brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3" },
    syntax: { keyword: "#859900", string: "#2aa198", number: "#d33682", comment: "#93a1a1", property: "#268bd2", tag: "#268bd2", attribute: "#b58900", heading: "#cb4b16", link: "#268bd2", emphasis: "#6c71c4", punctuation: "#93a1a1", meta: "#93a1a1" },
  },
  {
    id: "paper", name: "Paper (light)", dark: false,
    ui: { bg: "#ffffff", bgRaised: "#f4f5f7", bgHover: "#e9ebef", fg: "#24292f", fgDim: "#6e7781", fgFaint: "#b0b6bd", border: "#d8dde3", accent: "#0969da", selection: "#cfe3ff", danger: "#cf222e", codeBg: "#f4f5f7" },
    terminal: { background: "#ffffff", foreground: "#24292f", cursor: "#0969da", selectionBackground: "#cfe3ff", black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#9a6700", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781", brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#bf8700", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f" },
    syntax: { keyword: "#cf222e", string: "#0a3069", number: "#0550ae", comment: "#6e7781", property: "#953800", tag: "#116329", attribute: "#0550ae", heading: "#0969da", link: "#0969da", emphasis: "#8250df", punctuation: "#6e7781", meta: "#6e7781" },
  },
];

export function themeById(id: string): Theme {
  return themes.find((t) => t.id === id) ?? themes[0];
}
