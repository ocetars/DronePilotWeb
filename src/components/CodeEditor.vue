<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessage, ElButton, ElTooltip, ElButtonGroup, ElDropdown, ElDropdownMenu, ElDropdownItem } from 'element-plus'
import { VideoPlay, Delete, ArrowDown } from '@element-plus/icons-vue'
import loader from '@monaco-editor/loader'

const emit = defineEmits(['execute-code'])

const editorContainer = ref(null)
let codeEditor = null
const code = ref('')

// 从文件加载示例代码
async function loadExampleFromFile(filename) {
  try {
    const response = await fetch(`/userInput/${filename}`)
    if (!response.ok) {
      throw new Error('Failed to load example')
    }
    const content = await response.text()
    if (codeEditor) {
      codeEditor.setValue(content)  
      code.value = content
      ElMessage.success('已加载示例代码')
    }
  } catch (error) {
    ElMessage.error('加载示例代码失败')
    console.error('Error loading example:', error)
  }
}

// 示例代码配置
const examples = [
  { label: '原地画正方形', value: 'draw_square.js' },
  { label: '追踪红色圆', value: 'Red_or_Square.js' },
  { label: '高层API飞正方形', value: 'fly_square_api.js' },
]

async function loadTemplate(template) {
  await loadExampleFromFile(template)
}

function execute() {
  if (!code.value.trim()) {
    ElMessage.warning('请先输入代码')
    return
  }
  emit('execute-code', code.value)
}

function clearCode() {
  if (codeEditor) {
    codeEditor.setValue('')
    code.value = ''
  }
}

onMounted(() => {
  loader.init().then((monaco) => {
    codeEditor = monaco.editor.create(editorContainer.value, {
      value: code.value,
      language: 'javascript',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: {
        enabled: false,
      },
      fontSize: 20,
      fontFamily: 'Fira Code, monospace',
      lineHeight: 26,
    })

    codeEditor.onDidChangeModelContent(() => {
      code.value = codeEditor.getValue()
    })
  })
})

onBeforeUnmount(() => {
  if (codeEditor) {
    codeEditor.dispose()
    codeEditor = null
  }
})

watch(code, (newValue) => {
  if (codeEditor && codeEditor.getValue() !== newValue) {
    codeEditor.setValue(newValue)
  }
})

// 暴露获取当前代码的方法
defineExpose({
  getCurrentCode: () => code.value
})
</script>

<template>
  <div class="code-editor-container">
    <div class="toolbar">
        <el-button-group>
          <el-button type="primary" @click="execute">
            <el-icon><VideoPlay /></el-icon>
            <span class="button-text">执行</span>
          </el-button>
          <el-button @click="clearCode">
            <el-icon><Delete /></el-icon>
            <span class="button-text">清空</span>
          </el-button>
        </el-button-group>

        <el-dropdown @command="loadTemplate">
          <el-button type="primary" plain>
            加载示例
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item 
                v-for="example in examples" 
                :key="example.value"
                :command="example.value"
              >
                {{ example.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div ref="editorContainer" class="editor-container"></div>
  </div>
</template>

<style scoped>
.code-editor-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;  
}

.toolbar {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: flex-start;
  margin-bottom: 5px;
  margin-left: 70px;
}

.button-text {
  margin-left: 4px;
}

.editor-container {
  flex: 1;
}

:deep(.el-button) {
  display: inline-flex;
  align-items: center;
  background-color: #454545;
  border-color: #454545;
  color: white;
}

:deep(.el-button-group .el-button:first-child) {
  background-color: #2b7d4d;
  border-color: #2b7d4d;
}

:deep(.el-button-group .el-button:first-child:hover) {
  background-color: #3a9463;
  border-color: #3a9463;
}

:deep(.el-button:not(:first-child):hover) {
  background-color: #666666;
  border-color: #666666;
  color: white;
}

:deep(.el-dropdown-menu__item:not(.is-disabled):focus),
:deep(.el-dropdown-menu__item:not(.is-disabled):hover) {
  background-color: #9c9c9c;
  color: rgb(35, 35, 35);
  transition: all 0.1s ease;
}
</style> 