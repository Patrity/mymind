<script setup lang="ts">
definePageMeta({ layout: false })

const slug = useRoute().params.slug as string
const { data, error } = await useFetch(`/api/share/${slug}`)
if (error.value) throw createError({ statusCode: 404, statusMessage: 'Not found', fatal: true })
</script>

<template>
  <div class="min-h-screen bg-default text-default">
    <div class="max-w-3xl mx-auto p-6 sm:p-10">
      <h1 class="text-2xl font-semibold mb-6">
        {{ data?.title }}
      </h1>
      <MdView
        v-if="data?.language === 'markdown'"
        :source="data!.content"
      />
      <pre
        v-else
        class="whitespace-pre-wrap text-sm"
      >{{ data?.content }}</pre>
    </div>
  </div>
</template>
