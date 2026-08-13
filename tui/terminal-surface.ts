export interface TerminalSurface {
  enter(): void;
  restore(): void;
}

type TerminalWriter = Pick<NodeJS.WriteStream, "write">;

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h\u001b[2J\u001b[H\u001b[?25h";
const RESTORE_PRIMARY_SCREEN = "\u001b[?25h\u001b[?1049l";

export class AlternateScreenSurface implements TerminalSurface {
  #active = false;

  constructor(private readonly output: TerminalWriter = process.stdout) {}

  enter(): void {
    if (this.#active) return;
    this.#active = true;
    this.output.write(ENTER_ALTERNATE_SCREEN);
  }

  restore(): void {
    if (!this.#active) return;
    this.#active = false;
    this.output.write(RESTORE_PRIMARY_SCREEN);
  }
}
