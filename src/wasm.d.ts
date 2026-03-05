// WebAssembly ambient types for Node.js (avoids pulling in full DOM lib)
// Node has full WebAssembly support; TypeScript just needs the type declarations.

declare namespace WebAssembly {
  class Module {
    constructor(bytes: BufferSource);
  }
  class Instance {
    constructor(module: Module, importObject?: Imports);
    readonly exports: Exports;
  }
  class Memory {
    constructor(descriptor: MemoryDescriptor);
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }
  type ImportValue = Function | Memory | Global | Table;
  type Imports = Record<string, Record<string, ImportValue>>;
  type Exports = Record<string, Function | Memory | Global | Table>;
  class Global {
    constructor(descriptor: GlobalDescriptor, value?: unknown);
    value: unknown;
  }
  interface GlobalDescriptor {
    value: string;
    mutable?: boolean;
  }
  class Table {
    constructor(descriptor: TableDescriptor);
    readonly length: number;
  }
  interface TableDescriptor {
    element: string;
    initial: number;
    maximum?: number;
  }
}
