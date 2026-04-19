import { generateShortId, pickIds } from '../id'

describe('generateShortId', () => {
    // 15자 짧은 ID를 생성한다
    it('generates a 15-character short ID', () => {
        const id = generateShortId()
        // nanoid는 일반적으로 A-Z, a-z, 0-9를 사용
        const regex = /^[A-Za-z0-9]{15}$/

        expect(id).toMatch(regex)
    })

    // 매번 고유한 ID를 생성한다
    it('generates a unique ID each time', () => {
        const id1 = generateShortId()
        const id2 = generateShortId()

        expect(id1).not.toEqual(id2)
    })
})

describe('pickIds', () => {
    const items = [
        { id: '1', name: 'John' },
        { id: '2', name: 'Jane' },
        { id: '3', name: 'Bob' }
    ]

    // 입력 배열에 항목이 있을 때
    describe('when the input array contains items', () => {
        // id 값을 추출한다
        it('extracts the id values', () => {
            const result = pickIds(items)
            expect(result).toEqual(['1', '2', '3'])
        })
    })

    // 입력 배열이 비어 있을 때
    describe('when the input array is empty', () => {
        // 빈 배열을 반환한다
        it('returns an empty array', () => {
            const result = pickIds([])
            expect(result).toEqual([])
        })
    })
})
