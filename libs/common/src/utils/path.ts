import fs from 'fs/promises'
import { tmpdir } from 'os'
import p from 'path'
import { Checksum } from './checksum'

export class PathUtil {
    static basename(path: string): string {
        return p.basename(path)
    }

    static dirname(path: string): string {
        return p.dirname(path)
    }

    static getAbsolute(src: string): string {
        return p.isAbsolute(src) ? src : p.resolve(src)
    }

    static join(...paths: string[]): string {
        return p.join(...paths)
    }

    static sep() {
        return p.sep
    }

    static async copy(src: string, dest: string): Promise<void> {
        await fs.cp(src, dest, { force: true, recursive: true })
    }

    static async createTempDirectory(): Promise<string> {
        return fs.mkdtemp(`${tmpdir()}${p.sep}`)
    }

    static async delete(path: string): Promise<void> {
        await fs.rm(path, { force: true, recursive: true })
    }

    static async exists(path: string): Promise<boolean> {
        try {
            await fs.access(path)

            return true
        } catch {
            return false
        }
    }

    static async isDirectory(path: string): Promise<boolean> {
        const stats = await fs.stat(path)
        return stats.isDirectory()
    }

    static async isWritable(path: string): Promise<boolean> {
        try {
            await fs.access(path, fs.constants.W_OK)

            return true
        } catch {
            return false
        }
    }

    static async mkdir(path: string): Promise<void> {
        await fs.mkdir(path, { recursive: true })
    }

    static async move(src: string, dest: string): Promise<void> {
        // rename may fail if moving to a different file-system
        try {
            await fs.rename(src, dest)
        } catch (error: unknown) {
            const exdev = (error as NodeJS.ErrnoException).code === 'EXDEV'
            if (!exdev) throw error

            await this.copy(src, dest)
            await this.delete(src)
        }
    }

    static async subdirs(src: string): Promise<string[]> {
        const items = await fs.readdir(src, { withFileTypes: true })
        return items
            .filter((item) => item.isDirectory())
            .map((item) => item.name)
            .sort((left, right) => left.localeCompare(right))
    }

    static async areEqual(firstFilePath: string, secondFilePath: string): Promise<boolean> {
        const [firstSize, secondSize] = await Promise.all([
            this.getSize(firstFilePath),
            this.getSize(secondFilePath)
        ])

        if (firstSize !== secondSize) return false

        const [firstChecksum, secondChecksum] = await Promise.all([
            Checksum.fromFile(firstFilePath),
            Checksum.fromFile(secondFilePath)
        ])

        return (
            firstChecksum.algorithm === secondChecksum.algorithm &&
            firstChecksum.base64 === secondChecksum.base64
        )
    }

    static async getSize(filePath: string): Promise<number> {
        return (await fs.stat(filePath)).size
    }
}
