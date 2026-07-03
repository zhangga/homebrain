/**
 * 串行执行器：保证传入的异步任务一个接一个跑（FIFO），不并发。
 *
 * 用途：gbrain 底层 PGLite 是单写者，所有写操作必须串行化，
 * 否则并发写会争用写锁报错（见实现计划 §0 / 风险 R3）。
 */
export class Serializer {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * 把 task 排到队尾并返回它的结果。
   * 即使前一个任务抛错，也不阻断后续任务（队列只关心"前一个跑完了没"）。
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // 推进队列时吞掉成败，避免未处理的 rejection；调用方仍从 result 自己拿到 reject。
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
