# Form Patterns

Nuxt UI form components with Zod validation.

---

## Basic Form

```vue
<script setup lang="ts">
import { z } from 'zod'

const schema = z.object({
  email: z.string().email('Email address isn\'t valid — include an @ symbol'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  role: z.enum(['admin', 'user', 'viewer'])
})

type FormState = z.infer<typeof schema>

const state = reactive<FormState>({
  email: '',
  name: '',
  role: 'user'
})

const loading = ref(false)

async function onSubmit() {
  loading.value = true
  await api.createUser(state)
  loading.value = false
}
</script>

<template>
  <UForm :schema="schema" :state="state" @submit="onSubmit" class="space-y-4">
    <UFormField label="Name" name="name">
      <UInput v-model="state.name" placeholder="Jane Doe" />
    </UFormField>

    <UFormField label="Email" name="email">
      <UInput v-model="state.email" type="email" placeholder="jane@example.com" />
    </UFormField>

    <UFormField label="Role" name="role">
      <USelect v-model="state.role" :items="['admin', 'user', 'viewer']" />
    </UFormField>

    <UButton type="submit" :loading="loading">Create User</UButton>
  </UForm>
</template>
```

---

## Input Groups

Group related fields visually:

```vue
<div class="grid grid-cols-2 gap-4">
  <UFormField label="First Name" name="firstName">
    <UInput v-model="state.firstName" />
  </UFormField>
  <UFormField label="Last Name" name="lastName">
    <UInput v-model="state.lastName" />
  </UFormField>
</div>
```

---

## Toggle / Switch Fields

```vue
<UFormField label="Notifications" name="notifications">
  <USwitch v-model="state.notifications" />
</UFormField>

<UFormField label="Features" name="features">
  <div class="space-y-2">
    <UCheckbox v-model="state.darkMode" label="Dark mode" />
    <UCheckbox v-model="state.analytics" label="Analytics" />
  </div>
</UFormField>
```

---

## Textarea

```vue
<UFormField label="Bio" name="bio">
  <UTextarea v-model="state.bio" :rows="4" placeholder="Tell us about yourself..." />
</UFormField>
```

---

## Validation UX

- **Placeholders aren't labels** — they disappear on input. Always use `UFormField` with `label` prop
- **Validate on blur**, not every keystroke (exception: password strength)
- **Error messages need three parts**: what happened, why, how to fix — "Too short" → "Name must be at least 2 characters"
- Never blame the user — "Invalid email" → "Email address isn't valid"
- Mark required fields with label suffix, not asterisk
- Success state: brief toast, not inline message
- Disable submit button when `loading` is true
- Use `:loading` prop on submit button for spinner
- Use `v-model.nullable` (not `nullify`) for empty → `null` conversion
- Nested forms require `nested` prop and `name` prop on inner `UForm`

---

## Component Mapping

| Need | Component |
|------|-----------|
| Text input | `UInput` |
| Email/password | `UInput type="email"` |
| Long text | `UTextarea` |
| Number | `UInputNumber` |
| Single select | `USelect` |
| Searchable select | `USelectMenu` |
| On/off toggle | `USwitch` |
| Multi-option | `UCheckbox` in group / `UCheckboxGroup` |
| File upload | `UFileUpload` |
| Date picker | `UInputDate` |
| Time picker | `UInputTime` |
| Tags/chips | `UInputTags` |
| PIN/OTP | `UPinInput` |
| Color | `UColorPicker` |
