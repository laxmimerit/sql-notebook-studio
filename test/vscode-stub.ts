// The few parts of the vscode module that modules under test touch at load
// time. Tests run in plain Node, where the real module does not exist.
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T) {
    for (const l of this.listeners) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}
