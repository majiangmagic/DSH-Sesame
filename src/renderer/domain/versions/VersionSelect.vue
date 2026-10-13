<script lang="ts">
/**
 * 版本下拉的一个选项。
 *
 * `more` 是原版就有的"命令项"——「更多版本…（还有 N 个）」，点了不改变选中值，只展开列表。
 */
export interface VersionOption {
  value: string
  text: string
  badge?: string
  more?: boolean
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 自绘版本下拉（原版 `#versionPicker`）。
 *
 * 原版不用原生 `<select>`，而是自己画了一个带滑动高亮的 listbox，所以这里必须把它的
 * 交互一并复刻：点击开合、悬停高亮、上下键移动、Enter 选中、Esc 关闭、点击外部关闭、
 * 打开时把当前项滚进视野。DOM 结构、类名（含 selected / more / active）与原版一致。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    options: VersionOption[]
    disabled?: boolean
    placeholder?: string
  }>(),
  { disabled: false, placeholder: '' }
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  more: []
}>()

const { t } = useI18n()

const rootEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const open = ref(false)
const active = ref(-1)

/** 触发按钮上的文字：原版是 `text · badge`，没有徽标时只显示 text。 */
const triggerText = computed(() => {
  const hit = props.options.find((option) => option.value === props.modelValue)
  if (!hit) return props.placeholder || t('control.noVersions')
  return hit.badge ? `${hit.text} · ${hit.badge}` : hit.text
})

function scrollActiveIntoView(): void {
  void nextTick(() => {
    panelEl.value?.querySelector('.picker-option.view-active')?.scrollIntoView({ block: 'nearest' })
  })
}

function openPanel(): void {
  if (props.disabled || !props.options.length) return
  open.value = true
  active.value = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.modelValue)
  )
  scrollActiveIntoView()
}

function closePanel(): void {
  open.value = false
}

function togglePanel(): void {
  if (open.value) closePanel()
  else openPanel()
}

function choose(index: number): void {
  const option = props.options[index]
  if (!option) return
  if (option.more) {
    emit('more')
    return
  }
  if (option.value !== props.modelValue) emit('update:modelValue', option.value)
  closePanel()
}

function moveActive(step: number): void {
  if (!props.options.length) return
  const next = active.value + step
  // 到头就停住，原版也不循环
  active.value = Math.max(0, Math.min(props.options.length - 1, next))
  scrollActiveIntoView()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closePanel()
    return
  }
  if (!open.value && (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
    openPanel()
    return
  }
  if (!open.value) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    active.value = 0
    scrollActiveIntoView()
  } else if (event.key === 'End') {
    event.preventDefault()
    active.value = props.options.length - 1
    scrollActiveIntoView()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    choose(active.value)
  }
}

function onPointerDown(event: PointerEvent): void {
  if (!open.value) return
  if (!rootEl.value?.contains(event.target as Node)) closePanel()
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) closePanel()
  }
)

onMounted(() => document.addEventListener('pointerdown', onPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown))
</script>

<template>
  <div class="picker" id="versionPicker" ref="rootEl" :class="{ 'state-open': open }">
    <button
      type="button"
      class="picker-trigger"
      id="versionTrigger"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :disabled="disabled"
      @click="togglePanel"
      @keydown="onKeydown"
    >
      <span class="picker-value" id="versionValue">{{ triggerText }}</span>
      <svg class="picker-caret" viewBox="0 0 12 8" aria-hidden="true">
        <path fill="currentColor" d="M0 0h12L6 8z" />
      </svg>
    </button>
    <div class="picker-panel" id="versionPanel" role="listbox" ref="panelEl" :hidden="!open">
      <div
        v-for="(option, index) in options"
        :key="`${option.value}-${index}`"
        class="picker-option"
        :class="{
          'option-selected': option.value === modelValue,
          'expand-more': option.more,
          'view-active': index === active
        }"
        :data-index="index"
        role="option"
        :aria-selected="option.value === modelValue"
        @click="choose(index)"
        @mouseenter="active = index"
      >
        <span class="picker-option-name">{{ option.text }}</span>
        <span v-if="option.badge" class="picker-option-badge">{{ option.badge }}</span>
      </div>
    </div>
  </div>
</template>
