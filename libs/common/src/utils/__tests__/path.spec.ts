import fs from 'fs/promises'
import os from 'os'
import p from 'path'
import { PathUtil } from '../path'

describe('Path', () => {
    // 절대 경로를 반환한다
    it('returns an absolute path', async () => {
        const relativePath = `.${PathUtil.sep()}file.txt`
        const absolutePath = PathUtil.getAbsolute(relativePath)

        expect(p.isAbsolute(absolutePath)).toBe(true)
    })

    // 경로가 이미 절대 경로일 때
    describe('when the path is already absolute', () => {
        let absolutePath: string

        beforeEach(() => {
            absolutePath = p.join(os.tmpdir(), 'file.txt')
        })

        // 같은 경로를 반환한다
        it('returns the same path', async () => {
            const result = PathUtil.getAbsolute(absolutePath)

            expect(result).toEqual(absolutePath)
        })
    })

    // basename을 반환한다
    it('returns the basename', () => {
        const filePath = 'dir/file.txt'
        const basename = PathUtil.basename(filePath)

        expect(basename).toEqual('file.txt')
    })

    // dirname을 반환한다
    it('returns the dirname', () => {
        const filePath = 'dir/file.txt'
        const dirname = PathUtil.dirname(filePath)

        expect(dirname).toEqual('dir')
    })

    describe('file system operations', () => {
        let tempDir: string

        beforeEach(async () => {
            tempDir = await PathUtil.createTempDirectory()
        })

        afterEach(async () => {
            await PathUtil.delete(tempDir)
        })

        // 임시 디렉터리를 생성한다
        it('creates a temporary directory', async () => {
            const exists = await PathUtil.exists(tempDir)
            expect(exists).toBe(true)

            // OS의 임시 디렉터리 아래에 있는지 확인
            expect(tempDir.startsWith(os.tmpdir())).toBe(true)
        })

        // 지정한 경로가 존재하는지 비동기로 확인한다
        it('checks asynchronously whether the specified path exists', async () => {
            const filePath = PathUtil.join(tempDir, 'file.txt')
            await fs.writeFile(filePath, 'hello world')

            const exists = await PathUtil.exists(filePath)
            expect(exists).toBe(true)
        })

        // 경로가 존재하지 않을 때
        describe('when the path does not exist', () => {
            let nonExistentPath: string

            beforeEach(() => {
                nonExistentPath = PathUtil.join(tempDir, 'nonexistent.txt')
            })

            // false를 반환한다
            it('returns false', async () => {
                const exists = await PathUtil.exists(nonExistentPath)
                expect(exists).toBe(false)
            })
        })

        // 지정한 경로가 디렉터리인지 확인한다
        it('confirms whether the specified path is a directory', async () => {
            const exists = await PathUtil.isDirectory(tempDir)
            expect(exists).toBe(true)
        })

        // 디렉터리를 생성하고 삭제한다
        it('creates and deletes a directory', async () => {
            const dirPath = PathUtil.join(tempDir, 'testdir')

            await PathUtil.mkdir(dirPath)
            const exists = await PathUtil.exists(dirPath)
            expect(exists).toBe(true)

            await PathUtil.delete(dirPath)
            const existsAfterDelete = await PathUtil.exists(dirPath)
            expect(existsAfterDelete).toBe(false)
        })

        // 하위 디렉터리를 나열한다
        it('lists subdirectories', async () => {
            const subDir1 = PathUtil.join(tempDir, 'subdir1')
            await PathUtil.mkdir(subDir1)

            const subDir2 = PathUtil.join(tempDir, 'subdir2')
            await PathUtil.mkdir(subDir2)

            const srcFilePath = PathUtil.join(tempDir, 'file.txt')
            await fs.writeFile(srcFilePath, 'hello world')

            const subDirs = await PathUtil.subdirs(tempDir)
            expect(subDirs).toEqual(['subdir1', 'subdir2'])
        })

        // 파일을 복사한다
        it('copies a file', async () => {
            const srcFilePath = PathUtil.join(tempDir, 'file.txt')
            await fs.writeFile(srcFilePath, 'hello world')

            const destFilePath = PathUtil.join(tempDir, 'file_copy.txt')
            await PathUtil.copy(srcFilePath, destFilePath)

            const copiedExists = await PathUtil.exists(destFilePath)
            expect(copiedExists).toBe(true)

            // 복사된 파일의 내용 확인
            const content = await fs.readFile(destFilePath, 'utf-8')
            expect(content).toEqual('hello world')
        })

        // 디렉터리를 복사한다
        it('copies a directory', async () => {
            const srcDirPath = PathUtil.join(tempDir, 'testdir')
            await PathUtil.mkdir(srcDirPath)

            const fileInSrcDirPath = PathUtil.join(srcDirPath, 'file.txt')
            await fs.writeFile(fileInSrcDirPath, 'hello from the original dir')

            const destDirPath = PathUtil.join(tempDir, 'testdir_copy')
            await PathUtil.copy(srcDirPath, destDirPath)

            const copiedDirExists = await PathUtil.exists(destDirPath)
            expect(copiedDirExists).toBe(true)

            // 파일도 함께 복사되었는지 확인
            const copiedFilePath = PathUtil.join(destDirPath, 'file.txt')
            const copiedFileExists = await PathUtil.exists(copiedFilePath)
            expect(copiedFileExists).toBe(true)

            // 복사된 파일의 내용 확인
            const content = await fs.readFile(copiedFilePath, 'utf-8')
            expect(content).toEqual('hello from the original dir')
        })

        // 경로가 쓰기 가능할 때
        describe('when the path is writable', () => {
            beforeEach(() => {
                jest.spyOn(fs, 'access').mockResolvedValueOnce(undefined)
            })

            // true를 반환한다
            it('returns true', async () => {
                const result = await PathUtil.isWritable('/test/path')

                expect(result).toBe(true)
                expect(fs.access).toHaveBeenCalledWith('/test/path', fs.constants.W_OK)
            })
        })

        // 경로가 쓰기 불가능할 때
        describe('when the path is not writable', () => {
            beforeEach(() => {
                jest.spyOn(fs, 'access').mockRejectedValueOnce(new Error('Not writable'))
            })

            // false를 반환한다
            it('returns false', async () => {
                const result = await PathUtil.isWritable('/test/path')

                expect(result).toBe(false)
                expect(fs.access).toHaveBeenCalledWith('/test/path', fs.constants.W_OK)
            })
        })

        // 파일을 이동한다
        it('moves a file', async () => {
            const srcFilePath = PathUtil.join(tempDir, 'file.txt')
            await fs.writeFile(srcFilePath, 'hello world')

            const destFilePath = PathUtil.join(tempDir, 'move.txt')
            await PathUtil.move(srcFilePath, destFilePath)

            const movedExists = await PathUtil.exists(destFilePath)
            expect(movedExists).toBe(true)

            const srcExists = await PathUtil.exists(srcFilePath)
            expect(srcExists).toBe(false)

            const content = await fs.readFile(destFilePath, 'utf-8')
            expect(content).toEqual('hello world')
        })

        // rename이 EXDEV로 실패할 때
        describe('when rename fails with EXDEV', () => {
            // copy + delete로 폴백한다
            it('falls back to copy and delete', async () => {
                const src = '/tmp/src.txt'
                const dest = '/tmp/dest.txt'

                const exdevError = new Error('cross-device link') as NodeJS.ErrnoException
                exdevError.code = 'EXDEV'

                const renameSpy = jest.spyOn(fs, 'rename').mockRejectedValueOnce(exdevError)
                const copySpy = jest.spyOn(PathUtil, 'copy').mockResolvedValueOnce()
                const deleteSpy = jest.spyOn(PathUtil, 'delete').mockResolvedValueOnce()

                await PathUtil.move(src, dest)

                expect(renameSpy).toHaveBeenCalledWith(src, dest)
                expect(copySpy).toHaveBeenCalledWith(src, dest)
                expect(deleteSpy).toHaveBeenCalledWith(src)
            })
        })

        // rename이 EXDEV가 아닌 오류로 실패할 때
        describe('when rename fails with a non-EXDEV error', () => {
            // 오류를 그대로 던진다
            it('rethrows the error', async () => {
                const error = new Error('permission denied') as NodeJS.ErrnoException
                error.code = 'EACCES'

                jest.spyOn(fs, 'rename').mockRejectedValueOnce(error)

                await expect(PathUtil.move('/tmp/src.txt', '/tmp/dest.txt')).rejects.toThrow(
                    'permission denied'
                )
            })
        })

        describe('getSize', () => {
            // 파일 크기를 반환한다
            it('returns the file size', async () => {
                const filePath = PathUtil.join(tempDir, 'original.txt')
                await fs.writeFile(filePath, 'Hello, World!')

                const size = await PathUtil.getSize(filePath)

                expect(size).toBe('Hello, World!'.length)
            })
        })

        describe('areEqual', () => {
            let originalFilePath: string

            beforeEach(async () => {
                originalFilePath = PathUtil.join(tempDir, 'original.txt')
                await fs.writeFile(originalFilePath, 'Hello, World!')
            })

            // 파일이 동일할 때
            describe('when the files are identical', () => {
                let identicalFilePath: string

                beforeEach(async () => {
                    identicalFilePath = PathUtil.join(tempDir, 'identical.txt')
                    await fs.writeFile(identicalFilePath, 'Hello, World!')
                })

                // true를 반환한다
                it('returns true', async () => {
                    const areEqual = await PathUtil.areEqual(originalFilePath, identicalFilePath)
                    expect(areEqual).toBe(true)
                })
            })

            // 파일이 다를 때
            describe('when the files are different', () => {
                let differentFilePath: string

                beforeEach(async () => {
                    differentFilePath = PathUtil.join(tempDir, 'different.txt')
                    await fs.writeFile(differentFilePath, 'This is different')
                })

                // false를 반환한다
                it('returns false', async () => {
                    const areEqual = await PathUtil.areEqual(originalFilePath, differentFilePath)
                    expect(areEqual).toBe(false)
                })
            })
        })
    })
})
