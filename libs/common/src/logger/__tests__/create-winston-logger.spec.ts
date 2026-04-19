import type winston from 'winston'
import { isDebuggingEnabled } from '@mannercode/testing'
import { readFile } from 'fs/promises'
import { PathUtil, sleep } from '../../utils'
import { createWinstonLogger } from '../create-winston-logger'

const MESSAGE = Symbol.for('message')

function spyConsoleTransport(winstonLogger: winston.Logger) {
    const consoleTransport = winstonLogger.transports.find((t) => t.constructor.name === 'Console')
    if (!consoleTransport) throw new Error('Console transport not found')

    const spy = jest.spyOn(consoleTransport, 'log')

    return { getOutput: () => spy.mock.calls.map((c) => String(c[0][MESSAGE])).join('\n') }
}

describe('createWinstonLogger', () => {
    let logger: winston.Logger
    let tempDir: string

    beforeEach(async () => {
        tempDir = await PathUtil.createTempDirectory()

        logger = createWinstonLogger({
            consoleLogLevel: isDebuggingEnabled() ? 'verbose' : 'silent',
            daysToKeepLogs: '1d',
            directory: tempDir,
            fileLogLevel: 'verbose'
        })
    })

    afterEach(async () => {
        logger.close()
        await PathUtil.delete(tempDir)
    })

    async function getLogEntry() {
        const content = await readFile(PathUtil.join(tempDir, 'current.log'), 'utf-8')
        const entry = JSON.parse(content)
        return entry
    }

    // 일반 로그 항목을 기록한다
    it('writes a general log entry', async () => {
        const message = 'test message'

        logger.info(message)
        await sleep(200)

        const entry = await getLogEntry()

        expect(entry).toEqual({ level: 'info', message, timestamp: expect.any(String) })
    })

    // HTTP 로그 항목을 기록한다
    it('writes an HTTP log entry', async () => {
        const message = 'test message'
        const logDetails = {
            contextType: 'http',
            request: { body: 'body', method: 'GET', url: '/exception' },
            response: { code: 'ERR_CODE', message: 'message' },
            stack: 'stack...',
            statusCode: 500
        }

        logger.info(message, logDetails)
        await sleep(200)

        const entry = await getLogEntry()

        expect(entry).toEqual({
            ...logDetails,
            level: 'info',
            message,
            timestamp: expect.any(String)
        })
    })

    // HTTP 콘솔 포맷이 올바르게 출력된다
    it('formats HTTP log for console output', async () => {
        const consoleLogger = createWinstonLogger({
            consoleLogLevel: 'info',
            daysToKeepLogs: '1d',
            directory: tempDir,
            fileLogLevel: 'silent'
        })

        const { getOutput } = spyConsoleTransport(consoleLogger)

        const logDetails = {
            contextType: 'http',
            request: { body: {}, method: 'GET', url: '/test' },
            statusCode: 200
        }

        consoleLogger.info('success', logDetails)
        await sleep(200)

        const output = getOutput()
        expect(output).toContain('HTTP')
        expect(output).toContain('success')
        expect(output).toContain('/test')

        consoleLogger.close()
    })

    // Service 콘솔 포맷이 올바르게 출력된다
    it('formats service log for console output', async () => {
        const consoleLogger = createWinstonLogger({
            consoleLogLevel: 'info',
            daysToKeepLogs: '1d',
            directory: tempDir,
            fileLogLevel: 'silent'
        })

        const { getOutput } = spyConsoleTransport(consoleLogger)

        const logDetails = { contextType: 'service', movieId: 'mov-123', theaterCount: 5 }

        consoleLogger.info('BookingService.searchTheaters', logDetails)
        await sleep(200)

        const output = getOutput()
        expect(output).toContain('SERVICE')
        expect(output).toContain('BookingService.searchTheaters')
        expect(output).toContain('mov-123')
        expect(output).not.toContain('contextType')

        consoleLogger.close()
    })
})
