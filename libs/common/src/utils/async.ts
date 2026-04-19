export async function sleep(timeoutInMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, timeoutInMs))
}
