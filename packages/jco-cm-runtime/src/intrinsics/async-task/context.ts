import type { ThreadLookupContext, AsyncTaskModule, AsyncStringRealloc, TaskRegisters } from '../../runtime.js';
import { typeCheckValidI32 } from './helpers.js';
import { getCurrentTaskMeta } from '../task-context.js';
import { getCurrentThread } from './thread-operations.js';
import { debugLog } from '../core/debug.js';
import { getOrCreateAsyncState } from '../component.js';

/**
 * Find the context slots a guest realloc is running with.
 *
 * @param registers - registers naming what is currently executing
 * @param componentIdx - index of the component instance calling the context built-in
 * @returns the slots when the instance is inside a host call to its realloc, otherwise `undefined`
 */
function reallocStorage(registers: TaskRegisters, componentIdx: number | undefined): number[] | undefined {
    const reallocContext = registers.reallocContext;
    if (!reallocContext || reallocContext.componentIdx !== componentIdx) {
        return undefined;
    }
    return reallocContext.storage;
}

/** Implements `canon context.set`. */
export function contextSet(
    _context: ThreadLookupContext,
    ctx: {
        componentIdx?: number;
        slot: number;
    },
    value: number,
): ReturnType<AsyncTaskModule['contextSet']> {
    const { slot } = ctx;
    if (slot === undefined) {
        throw new TypeError('missing slot');
    }
    if (!typeCheckValidI32(value)) {
        throw new Error('invalid value for context set (not valid i32)');
    }
    // A realloc called by the host runs with slots of its own.
    const reallocSlots = reallocStorage(_context.registers, ctx.componentIdx);
    if (reallocSlots) {
        if (slot < 0 || slot >= reallocSlots.length) {
            throw new Error('invalid slot for current thread');
        }
        reallocSlots[slot] = value;
        return;
    }
    // Guest callbacks use their component's task register. FACT
    // adapters have no component index; post-return also runs
    // after the callee register is cleared. Both use the executing
    // task, whose context FACT temporarily saves and restores.
    let currentThreadMeta = getCurrentTaskMeta(_context.registers, ctx.componentIdx);
    let threadMeta = currentThreadMeta
        ? getCurrentThread(
              _context,
              currentThreadMeta.componentIdx,
              currentThreadMeta.threadID,
              currentThreadMeta.taskID,
          )
        : undefined;
    // A post-return may run after the callee has exited. Its
    // per-component register can therefore name a task which is
    // no longer live; fall back to FACT's executing task.
    if (!threadMeta) {
        currentThreadMeta = getCurrentTaskMeta(_context.registers);
        threadMeta = currentThreadMeta
            ? getCurrentThread(
                  _context,
                  currentThreadMeta.componentIdx,
                  currentThreadMeta.threadID,
                  currentThreadMeta.taskID,
              )
            : undefined;
    }
    if (!threadMeta) {
        throw new Error(
            `missing/incomplete global current thread meta for component idx [${ctx.componentIdx}] during context set`,
        );
    }
    const task = threadMeta.thread;
    if (!task) {
        throw new Error('invalid/missing current thread in metadata while setting context');
    }
    debugLog('[contextSet()] args', {
        slot,
        value,
        storage: task.storage,
        threadID: task.id(),
        taskID: threadMeta.task.id(),
        componentIdx: task.componentIdx(),
    });
    if (slot < 0 || slot >= task.storage.length) {
        throw new Error('invalid slot for current thread');
    }
    task.storage[slot] = value;
}

/** Implements `canon context.get`. */
export function contextGet(
    _context: ThreadLookupContext,
    ctx: {
        componentIdx?: number;
        slot: number;
    },
): ReturnType<AsyncTaskModule['contextGet']> {
    const { slot } = ctx;
    if (slot === undefined) {
        throw new TypeError('missing slot');
    }
    // A realloc called by the host runs with slots of its own.
    const reallocSlots = reallocStorage(_context.registers, ctx.componentIdx);
    if (reallocSlots) {
        if (slot < 0 || slot >= reallocSlots.length) {
            throw new Error('invalid slot for current thread');
        }
        return reallocSlots[slot];
    }
    // Guest callbacks use their component's task register. FACT
    // adapters have no component index; post-return also runs
    // after the callee register is cleared. Both use the executing
    // task, whose context FACT temporarily saves and restores.
    let currentThreadMeta = getCurrentTaskMeta(_context.registers, ctx.componentIdx);
    let threadMeta = currentThreadMeta
        ? getCurrentThread(
              _context,
              currentThreadMeta.componentIdx,
              currentThreadMeta.threadID,
              currentThreadMeta.taskID,
          )
        : undefined;
    // A post-return may run after the callee has exited. Its
    // per-component register can therefore name a task which is
    // no longer live; fall back to FACT's executing task.
    if (!threadMeta) {
        currentThreadMeta = getCurrentTaskMeta(_context.registers);
        threadMeta = currentThreadMeta
            ? getCurrentThread(
                  _context,
                  currentThreadMeta.componentIdx,
                  currentThreadMeta.threadID,
                  currentThreadMeta.taskID,
              )
            : undefined;
    }
    if (!threadMeta) {
        throw new Error(
            `missing/incomplete global current thread meta for component idx [${ctx.componentIdx}] during context get`,
        );
    }
    const task = threadMeta.thread;
    if (!task) {
        throw new Error('invalid/missing current thread in metadata while getting context');
    }
    debugLog('[contextGet()] args', {
        slot,
        storage: task.storage,
        threadID: task.id(),
        taskID: threadMeta.task.id(),
        componentIdx: task.componentIdx(),
    });
    if (slot < 0 || slot >= task.storage.length) {
        throw new Error('invalid slot for current thread');
    }
    return task.storage[slot];
}

/**
 * Wrap a guest realloc so each call runs with fresh context slots and without leaving the component.
 *
 * The host calls a guest's realloc to lower values into its memory, possibly while one of the guest's
 * tasks is suspended. Every such call runs as though on a fresh thread: it reads zeroed context slots,
 * and what it writes to them is discarded when it returns. No thread's own slots are involved.
 *
 * A realloc that may not leave its component instance cannot suspend, so it has finished by the time
 * the call returns, even where the call yields a promise.
 *
 * @param context - capabilities for locating component state and the executing registers
 * @param componentIdx - index of the component instance that owns the realloc
 * @param realloc - the guest realloc to wrap
 * @returns a realloc with the same signature
 */
export function isolateRealloc(
    context: ThreadLookupContext,
    componentIdx: number,
    realloc: AsyncStringRealloc,
): ReturnType<AsyncTaskModule['isolateRealloc']> {
    return (oldPtr, oldSize, alignment, newSize) => {
        const state = getOrCreateAsyncState(context.lookup, componentIdx);
        const { registers } = context;
        const previousReallocContext = registers.reallocContext ?? null;
        const previousMayLeave = state.mayLeave;

        registers.reallocContext = { componentIdx, storage: [0, 0] };
        state.mayLeave = false;
        try {
            return realloc(oldPtr, oldSize, alignment, newSize);
        } finally {
            state.mayLeave = previousMayLeave;
            registers.reallocContext = previousReallocContext;
        }
    };
}
