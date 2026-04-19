import { randomBytes } from 'crypto'

/**
 * Generates a short unique identifier (ID) with the specified length.
 * 지정된 길이의 짧은 고유 식별자(ID)를 생성합니다.
 *
 * @param {number} [length=15] - The length of the ID to generate (default: 15).
 * @returns {string} The generated short ID string.
 */
export function generateShortId(length: number = 15): string {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const characterCount = characters.length
    const maxByte = 256 - (256 % characterCount)

    let shortId = ''
    while (shortId.length < length) {
        const bytes = randomBytes(length)

        for (const byte of bytes) {
            if (byte < maxByte) {
                shortId += characters[byte % characterCount]

                if (shortId.length === length) {
                    break
                }
            }
        }
    }

    return shortId
}

/**
 * Extracts the 'id' property from each object in an array.
 * 객체 배열에서 각 객체의 'id' 프로퍼티를 추출
 */
export function pickIds<T extends { id: string }>(items: T[]): string[] {
    return items.map((item) => item.id)
}
