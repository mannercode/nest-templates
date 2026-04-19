import fs from 'fs/promises'
import { Checksum } from '../checksum'
import { PathUtil } from '../path'

describe('Checksum', () => {
    describe('fromFile', () => {
        let tempDir: string
        let filePath: string

        beforeEach(async () => {
            tempDir = await PathUtil.createTempDirectory()
            filePath = PathUtil.join(tempDir, 'original.txt')

            await fs.writeFile(filePath, 'Hello, World!')
        })

        afterEach(async () => {
            await PathUtil.delete(tempDir)
        })

        // 알고리즘이 sha1일 때
        describe('when the algorithm is sha1', () => {
            // SHA1 체크섬을 반환한다
            it('returns the SHA1 checksum', async () => {
                const checksum = await Checksum.fromFile(filePath, 'sha1')

                expect(checksum).toEqual({
                    algorithm: 'sha1',
                    base64: 'CgqfKmdylCVXq1NV12r0Qvj2XgE='
                })
            })
        })

        // 알고리즘이 제공되지 않을 때
        describe('when the algorithm is not provided', () => {
            // SHA256 체크섬을 반환한다
            it('returns the SHA256 checksum', async () => {
                const checksum = await Checksum.fromFile(filePath)

                expect(checksum).toEqual({
                    algorithm: 'sha256',
                    base64: '3/1gIbsr1bCvZ2KQgJ7DpTGR3YHH9wpLKGiKNiGCmG8='
                })
            })
        })
    })

    describe('fromBuffer', () => {
        let buffer: Buffer

        beforeEach(async () => {
            buffer = Buffer.from('Hello, World!')
        })

        // 알고리즘이 sha1일 때
        describe('when the algorithm is sha1', () => {
            // SHA1 체크섬을 반환한다
            it('returns the SHA1 checksum', async () => {
                const checksum = Checksum.fromBuffer(buffer, 'sha1')

                expect(checksum).toEqual({
                    algorithm: 'sha1',
                    base64: 'CgqfKmdylCVXq1NV12r0Qvj2XgE='
                })
            })
        })

        // 알고리즘이 제공되지 않을 때
        describe('when the algorithm is not provided', () => {
            // SHA256 체크섬을 반환한다
            it('returns the SHA256 checksum', async () => {
                const checksum = Checksum.fromBuffer(buffer)

                expect(checksum).toEqual({
                    algorithm: 'sha256',
                    base64: '3/1gIbsr1bCvZ2KQgJ7DpTGR3YHH9wpLKGiKNiGCmG8='
                })
            })
        })
    })
})
