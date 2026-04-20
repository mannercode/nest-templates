const { bundleWorkflowCode } = require('@temporalio/worker')
const path = require('path')
const fs = require('fs')

async function main() {
    const workflowsPath = path.resolve(__dirname, '../src/apps/applications/workflows.ts')

    const outputDir = path.resolve(__dirname, '../_output/dist')
    fs.mkdirSync(outputDir, { recursive: true })

    if (!fs.existsSync(workflowsPath)) {
        console.log('No workflows found, creating empty placeholder')
        fs.writeFileSync(path.join(outputDir, 'workflow-bundle.js'), '')
        return
    }

    const bundle = await bundleWorkflowCode({ workflowsPath })

    fs.writeFileSync(path.join(outputDir, 'workflow-bundle.js'), bundle.code)

    console.log('Workflow bundle created at _output/dist/workflow-bundle.js')
}

main().catch((err) => {
    console.error('Failed to bundle workflows:', err)
    process.exit(1)
})
