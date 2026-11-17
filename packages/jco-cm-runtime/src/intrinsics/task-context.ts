import { isPromiseLike } from './core/promises.js';
import type { CoreModule, TaskMeta, TaskRegisters } from '../runtime.js';
import { debugLog } from './core/debug.js';

export const initializeTaskRegisters: CoreModule['initializeTaskRegisters'] = () => ({ storage: {}, threadTables: {} });

function validate(args: TaskMeta) {
    if (!args) {
        throw new TypeError('args missing');
    }
    if (args.taskID === undefined) {
        throw new TypeError('missing task ID');
    }
    if (args.threadID === undefined) {
        throw new TypeError('missing thread ID');
    }
    if (args.componentIdx === undefined) {
        throw new TypeError('missing component idx');
    }
}

export const getCurrentTaskMeta: CoreModule['getCurrentTaskMeta'] = (registers, componentIdx) => {
    const value = componentIdx === undefined || componentIdx === null ? registers.current : registers[componentIdx];
    return value === undefined || value === null ? undefined : { ...value };
};

export const setCurrentTaskMeta: CoreModule['setCurrentTaskMeta'] = (registers, args) => {
    validate(args);
    const { taskID, threadID, componentIdx } = args;
    // Resolve storage once at entry; context.get/set only dereference the active slots.
    const thread = registers.threadTables?.[componentIdx]?.get(threadID);
    const storage = (registers.storage ??= {});
    storage.current = storage[componentIdx] = thread?.taskID() === taskID ? thread.contextStorage : undefined;
    return (registers.current = registers[componentIdx] = { taskID, threadID, componentIdx });
};

export function withCurrentTaskMeta<T>(registers: TaskRegisters, args: TaskMeta & { fn: () => T }): T {
    debugLog('[_withGlobalCurrentThreadMeta()] args', args);
    validate(args);
    if (!args.fn) {
        throw new TypeError('missing fn');
    }
    const { componentIdx, fn } = args;
    const previous = registers[componentIdx] ?? null;
    const previousCurrent = registers.current ?? null;
    const storage = (registers.storage ??= {});
    const previousStorage = storage[componentIdx];
    const previousCurrentStorage = storage.current;
    try {
        setCurrentTaskMeta(registers, args);
        return fn();
    } catch (error) {
        debugLog('error while executing sync callee/callback', { ...args, err: error });
        throw error;
    } finally {
        registers[componentIdx] = previous;
        registers.current = previousCurrent;
        storage[componentIdx] = previousStorage;
        storage.current = previousCurrentStorage;
    }
}

export function withCurrentTaskMetaAsync<T>(
    registers: TaskRegisters,
    args: TaskMeta & { fn: () => T },
): T | Promise<Awaited<T>> {
    debugLog('[_withGlobalCurrentThreadMetaAsync()] args', args);
    validate(args);
    if (!args.fn) {
        throw new TypeError('missing fn');
    }
    const { taskID, threadID, componentIdx, fn } = args;
    const previous = registers[componentIdx] ?? null;
    const previousCurrent = registers.current ?? null;
    const storage = (registers.storage ??= {});
    const previousStorage = storage[componentIdx];
    const previousCurrentStorage = storage.current;
    let result: T;
    try {
        setCurrentTaskMeta(registers, args);
        result = fn();
    } catch (error) {
        debugLog('error while executing sync callee/callback', { ...args, err: error });
        registers[componentIdx] = previous;
        registers.current = previousCurrent;
        storage[componentIdx] = previousStorage;
        storage.current = previousCurrentStorage;
        throw error;
    }
    if (!isPromiseLike(result)) {
        registers[componentIdx] = previous;
        registers.current = previousCurrent;
        storage[componentIdx] = previousStorage;
        storage.current = previousCurrentStorage;
        return result;
    }
    return (async (): Promise<Awaited<T>> => {
        try {
            return (await result) as Awaited<T>;
        } catch (error) {
            debugLog('error while executing async callee/callback', { ...args, err: error });
            throw error;
        } finally {
            // A later thread of the same task may already own either register.
            if (registers[componentIdx]?.threadID === threadID && registers[componentIdx]?.taskID === taskID) {
                registers[componentIdx] = null;
                storage[componentIdx] = undefined;
            }
            if (registers.current?.threadID === threadID && registers.current?.taskID === taskID) {
                registers.current = null;
                storage.current = undefined;
            }
        }
    })();
}

export const clearCurrentTaskMeta: CoreModule['clearCurrentTaskMeta'] = async (registers, args) => {
    debugLog('[_clearCurrentTask()] args', args);
    validate(args);
    const { taskID, threadID, componentIdx } = args;
    const meta = registers[componentIdx];
    if (!meta) {
        throw new Error(`missing current thread meta for component idx [${componentIdx}]`);
    }
    if (meta.threadID !== threadID) {
        throw new Error(`thread ID [${meta.threadID}] != requested ID [${threadID}]`);
    }
    if (meta.taskID !== taskID) {
        throw new Error(`task ID [${meta.taskID}] != requested ID [${taskID}]`);
    }
    if (meta.componentIdx !== componentIdx) {
        throw new Error(`component idx [${meta.componentIdx}] != requested idx [${componentIdx}]`);
    }
    registers[componentIdx] = null;
    const storage = (registers.storage ??= {});
    storage[componentIdx] = undefined;
    if (registers.current?.threadID === threadID && registers.current?.taskID === taskID) {
        registers.current = null;
        storage.current = undefined;
    }
};
