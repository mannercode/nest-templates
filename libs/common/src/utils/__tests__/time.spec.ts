import { TimeUtil } from '../time'

describe('Time', () => {
    describe('toMs', () => {
        // 유효한 시간 문자열을 밀리초로 변환한다
        it('converts a valid time string to milliseconds', () => {
            expect(TimeUtil.toMs('30m')).toEqual(30 * 60 * 1000)
            expect(TimeUtil.toMs('45s')).toEqual(45 * 1000)
            expect(TimeUtil.toMs('1d')).toEqual(24 * 60 * 60 * 1000)
            expect(TimeUtil.toMs('2h')).toEqual(2 * 60 * 60 * 1000)
            expect(TimeUtil.toMs('1d 2h')).toEqual((24 + 2) * 60 * 60 * 1000)
            expect(TimeUtil.toMs('1d2h')).toEqual((24 + 2) * 60 * 60 * 1000)
            expect(TimeUtil.toMs('-30s')).toEqual(-30 * 1000)
            expect(TimeUtil.toMs('0.5s')).toEqual(0.5 * 1000)
            expect(TimeUtil.toMs('500ms')).toEqual(500)
        })

        // 유효하지 않은 형식이면 예외를 던진다
        it('throws for an invalid format', () => {
            expect(() => TimeUtil.toMs('2z')).toThrow(Error)
        })
    })

    describe('fromMs', () => {
        // 밀리초를 문자열로 변환한다
        it('converts milliseconds to a string', () => {
            expect(TimeUtil.fromMs(30 * 60 * 1000)).toEqual('30m')
            expect(TimeUtil.fromMs(45 * 1000)).toEqual('45s')
            expect(TimeUtil.fromMs(24 * 60 * 60 * 1000)).toEqual('1d')
            expect(TimeUtil.fromMs(2 * 60 * 60 * 1000)).toEqual('2h')
            expect(TimeUtil.fromMs((24 + 2) * 60 * 60 * 1000)).toEqual('1d2h')
            expect(TimeUtil.fromMs(500)).toEqual('500ms')
            expect(TimeUtil.fromMs(0)).toEqual('0ms')
            expect(TimeUtil.fromMs(-30 * 1000)).toEqual('-30s')
        })
    })
})
